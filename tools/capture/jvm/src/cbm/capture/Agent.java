package cbm.capture;

import java.lang.instrument.Instrumentation;
import java.lang.instrument.ClassFileTransformer;
import java.nio.file.*;
import java.nio.charset.StandardCharsets;
import java.security.*;
import java.util.*;
import org.objectweb.asm.*;
import org.objectweb.asm.tree.*;

/** Load-time agent; removing -javaagent removes every probe on the next launch. */
public final class Agent {
    private record Source(String classHash,String path,String hash,String language,int lines) {}
    private static final String PROBE="cbm/capture/Probe";
    public static void premain(String manifest, Instrumentation instrumentation) {
        try {
            if(!Probe.start())return;
            Path file=Path.of(manifest).toRealPath();
            if(Files.size(file)>4*1024*1024)throw new IllegalArgumentException();
            List<String> rows=Files.readAllLines(file,StandardCharsets.UTF_8);
            String[] header=rows.get(0).split("\t");
            if(header.length!=2 || !header[0].equals("CBM-JVM-1") || rows.size()>4097)throw new IllegalArgumentException();
            Path root=Path.of(decode(header[1])).toRealPath();
            Map<String,Source> sources=new HashMap<>();
            for(String row:rows.subList(1,rows.size())){
                String[] fields=row.split("\t");
                if(fields.length!=5 || !fields[1].matches("[a-f0-9]{64}") || !fields[3].matches("[a-f0-9]{64}"))throw new IllegalArgumentException();
                String relative=decode(fields[2]);
                Path path=root.resolve(relative).normalize();
                if(!path.startsWith(root) || Path.of(relative).isAbsolute() || !path.toRealPath().equals(path) || Files.size(path)>4*1024*1024)continue;
                byte[] bytes=Files.readAllBytes(path);
                if(!sha(bytes).equals(fields[3])){
                    Probe.skipped(relative,fields[3],fields[0],1,"Source hash changed after overlay compilation; class excluded.");continue;
                }
                int lines=1;for(byte b:bytes)if(b=='\n')lines++;
                sources.put(fields[0],new Source(fields[1],relative,fields[3],fields[4],lines));
            }
            instrumentation.addTransformer(new ClassFileTransformer(){
                @Override public byte[] transform(Module module,ClassLoader loader,String name,Class<?> redef,ProtectionDomain domain,byte[] bytes){
                    Source source=sources.get(name);
                    if(source==null)return null;
                    if(loader!=ClassLoader.getSystemClassLoader() || module.isNamed() || !sha(bytes).equals(source.classHash)){
                        Probe.skipped(source.path,source.hash,name,1,"Class hash, class loader or named module is outside this compiled overlay.");return null;
                    }
                    try{return instrument(bytes,source,loader);}
                    catch(Throwable failure){Probe.skipped(source.path,source.hash,name,1,"Class transformation unsupported; original bytecode retained.");return null;}
                }
            });
        }catch(Throwable failure){System.err.println("CBM JVM capture unavailable; application runs without instrumentation.");}
    }
    private static String decode(String value){return new String(Base64.getDecoder().decode(value),StandardCharsets.UTF_8);}
    private static String sha(byte[] bytes){
        try{return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));}
        catch(NoSuchAlgorithmException impossible){throw new AssertionError(impossible);}
    }
    private static InsnList args(Object... values){
        InsnList out=new InsnList();
        for(Object value:values){
            if(value instanceof Boolean b)out.add(new InsnNode(b?Opcodes.ICONST_1:Opcodes.ICONST_0));
            else out.add(new LdcInsnNode(value));
        }
        return out;
    }
    private static void invoke(InsnList out,String name,String descriptor){out.add(new MethodInsnNode(Opcodes.INVOKESTATIC,PROBE,name,descriptor,false));}
    private static InsnList probe(String name,String descriptor,Object... values){InsnList out=args(values);invoke(out,name,descriptor);return out;}
    private static void box(InsnList out,Type type){
        String owner=switch(type.getSort()){
            case Type.BOOLEAN -> "java/lang/Boolean";case Type.BYTE -> "java/lang/Byte";case Type.CHAR -> "java/lang/Character";
            case Type.SHORT -> "java/lang/Short";case Type.INT -> "java/lang/Integer";case Type.LONG -> "java/lang/Long";
            case Type.FLOAT -> "java/lang/Float";case Type.DOUBLE -> "java/lang/Double";default -> null;
        };
        if(owner!=null)out.add(new MethodInsnNode(Opcodes.INVOKESTATIC,owner,"valueOf","("+type.getDescriptor()+")L"+owner+";",false));
    }
    private static Type variableType(int opcode){
        return switch(opcode){
            case Opcodes.LLOAD,Opcodes.LSTORE -> Type.LONG_TYPE;case Opcodes.DLOAD,Opcodes.DSTORE -> Type.DOUBLE_TYPE;
            case Opcodes.FLOAD,Opcodes.FSTORE -> Type.FLOAT_TYPE;case Opcodes.ALOAD,Opcodes.ASTORE -> Type.getType(Object.class);
            default -> Type.INT_TYPE;
        };
    }
    private static String localName(MethodNode method,int slot,int index,AbstractInsnNode[] original){
        String best="slot"+slot;int distance=Integer.MAX_VALUE;
        if(method.localVariables!=null)for(LocalVariableNode local:method.localVariables){
            if(local.index!=slot)continue;
            int start=Arrays.asList(original).indexOf(local.start),end=Arrays.asList(original).indexOf(local.end);
            // javac starts a variable's debug scope immediately after its first store.
            if(index<end && start<=index+3){
                int candidate=Math.abs(index-start);if(candidate<distance){best=local.name;distance=candidate;}
            }
        }
        return best;
    }
    private static byte[] instrument(byte[] bytes,Source source,ClassLoader loader)throws Exception{
        ClassReader reader=new ClassReader(bytes);ClassNode owner=new ClassNode();reader.accept(owner,ClassReader.EXPAND_FRAMES);
        for(MethodNode method:owner.methods){
            if((method.access&(Opcodes.ACC_ABSTRACT|Opcodes.ACC_NATIVE))!=0)continue;
            String symbol=owner.name.replace('/','.')+"."+method.name+method.desc;
            AbstractInsnNode[] original=method.instructions.toArray();
            int firstLine=1;for(AbstractInsnNode n:original)if(n instanceof LineNumberNode l){firstLine=l.line;break;}
            String reason=null;
            if(method.name.startsWith("<"))reason="Constructor/class initializer body is outside the supported method frame model.";
            if(method.desc.contains("Lkotlin/coroutines/Continuation;"))reason="Kotlin suspended execution requires a continuation-aware adapter.";
            if(owner.sourceDebug!=null && owner.sourceDebug.contains("SMAP"))reason="Inlined/multi-source debug mapping is not yet supported.";
            for(AbstractInsnNode n:original){
                if(n.getOpcode()==Opcodes.JSR || n.getOpcode()==Opcodes.RET)reason="Legacy subroutine bytecode is unsupported.";
                if(n instanceof LineNumberNode line && (line.line<1 || line.line>source.lines))reason="Debug line is outside the exact compiled source.";
            }
            if(reason!=null){Probe.skipped(source.path,source.hash,symbol,Math.min(source.lines,Math.max(1,firstLine)),reason);continue;}
            if(original.length>20000){Probe.skipped(source.path,source.hash,symbol,firstLine,"Method instruction budget exceeded.");continue;}
            InsnList entry=args(Type.getObjectType(owner.name),source.path,source.hash,symbol,method.name,method.desc,(method.access&Opcodes.ACC_STATIC)!=0,firstLine);
            invoke(entry,"enter","(Ljava/lang/Class;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;ZI)V");
            int slot=(method.access&Opcodes.ACC_STATIC)!=0?0:1,parameter=0;
            for(Type type:Type.getArgumentTypes(method.desc)){
                String name=localName(method,slot,0,original);
                if(name.startsWith("slot") && method.parameters!=null && parameter<method.parameters.size())name=method.parameters.get(parameter).name;
                entry.add(args(slot,parameter,type.getSize(),name));entry.add(new VarInsnNode(type.getOpcode(Opcodes.ILOAD),slot));box(entry,type);
                invoke(entry,"parameter","(IIILjava/lang/String;Ljava/lang/Object;)V");
                slot+=type.getSize();parameter++;
            }
            LabelNode protectedStart=new LabelNode();entry.add(protectedStart);
            method.instructions.insert(entry);
            var handlers=new HashSet<LabelNode>();
            for(TryCatchBlockNode handler:method.tryCatchBlocks)handlers.add(handler.handler);
            int line=firstLine;
            for(int index=0;index<original.length;index++){
                AbstractInsnNode node=original[index];int opcode=node.getOpcode();
                if(node instanceof LineNumberNode location){line=location.line;continue;}
                if(node instanceof LabelNode label && handlers.contains(label)){
                    method.instructions.insert(label,probe("caught","(I)V",line));continue;
                }
                if(opcode<0)continue;
                InsnList before=new InsnList(),after=new InsnList();
                if(node instanceof VarInsnNode variable){
                    Type type=variableType(opcode);
                    if(opcode>=Opcodes.ILOAD && opcode<=Opcodes.ALOAD)after=probe("load","(III)V",variable.var,type.getSize(),line);
                    else if(opcode>=Opcodes.ISTORE && opcode<=Opcodes.ASTORE){
                        after=args(variable.var,type.getSize(),localName(method,variable.var,index,original),line);
                        after.add(new VarInsnNode(type.getOpcode(Opcodes.ILOAD),variable.var));box(after,type);
                        invoke(after,"store","(IILjava/lang/String;ILjava/lang/Object;)V");
                    }
                }else if(node instanceof IincInsnNode increment){
                    after=args(increment.var,localName(method,increment.var,index,original),line);
                    after.add(new VarInsnNode(Opcodes.ILOAD,increment.var));box(after,Type.INT_TYPE);
                    invoke(after,"increment","(ILjava/lang/String;ILjava/lang/Object;)V");
                }else if(node instanceof MethodInsnNode call){
                    before=probe("before","(Ljava/lang/Class;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;IZZI)V",
                        Type.getObjectType(owner.name),call.owner,call.name,call.desc,Type.getArgumentTypes(call.desc).length,
                        opcode==Opcodes.INVOKESTATIC,opcode!=Opcodes.INVOKESTATIC,line);
                    after=probe("after","(II)V",Type.getReturnType(call.desc).getSize(),line);
                }else if(node instanceof InvokeDynamicInsnNode call){
                    after=probe("opaque","(IIILjava/lang/String;)V",Type.getArgumentTypes(call.desc).length,Type.getReturnType(call.desc).getSize(),line,
                                "Dynamic invocation result observed; target and argument transport are unproven.");
                }else if(node instanceof FieldInsnNode field){
                    Type type=Type.getType(field.desc);int temporary=method.maxLocals;method.maxLocals+=type.getSize();
                    boolean read=opcode==Opcodes.GETFIELD || opcode==Opcodes.GETSTATIC;
                    if(!read){before.add(new VarInsnNode(type.getOpcode(Opcodes.ISTORE),temporary));before.add(new VarInsnNode(type.getOpcode(Opcodes.ILOAD),temporary));}
                    else after.add(new VarInsnNode(type.getOpcode(Opcodes.ISTORE),temporary));
                    after.add(args(opcode,type.getSize(),field.owner.replace('/','.')+"."+field.name,line));
                    after.add(new VarInsnNode(type.getOpcode(Opcodes.ILOAD),temporary));box(after,type);
                    invoke(after,"field","(IILjava/lang/String;ILjava/lang/Object;)V");
                    if(read)after.add(new VarInsnNode(type.getOpcode(Opcodes.ILOAD),temporary));
                }else if(node instanceof JumpInsnNode){
                    int count=opcode==Opcodes.GOTO?0:(opcode>=Opcodes.IF_ICMPEQ && opcode<=Opcodes.IF_ACMPNE)?2:1;
                    before=probe("discard","(II)V",count,line);
                }else if(node instanceof TableSwitchInsnNode || node instanceof LookupSwitchInsnNode){
                    before=probe("discard","(II)V",1,line);
                }else if(node instanceof LdcInsnNode constant){
                    after=probe("value","(II)V",constant.cst instanceof Long || constant.cst instanceof Double?2:1,line);
                }else if(opcode>=Opcodes.ACONST_NULL && opcode<=Opcodes.SIPUSH){
                    after=probe("value","(II)V",opcode==Opcodes.LCONST_0 || opcode==Opcodes.LCONST_1 || opcode==Opcodes.DCONST_0 || opcode==Opcodes.DCONST_1?2:1,line);
                }else if(opcode>=Opcodes.POP && opcode<=Opcodes.SWAP){
                    after=probe("stack","(I)V",opcode);
                }else if(opcode>=Opcodes.IADD && opcode<=Opcodes.LXOR){
                    boolean unary=opcode>=Opcodes.INEG && opcode<=Opcodes.DNEG;
                    int width=opcode>=Opcodes.ISHL?((opcode-Opcodes.ISHL)%2==1?2:1):((opcode-Opcodes.IADD)%4==1 || (opcode-Opcodes.IADD)%4==3?2:1);
                    after=probe("transform","(III)V",unary?1:2,width,line);
                }else if(opcode>=Opcodes.I2L && opcode<=Opcodes.I2S){
                    int width=Set.of(Opcodes.I2L,Opcodes.I2D,Opcodes.L2D,Opcodes.F2L,Opcodes.F2D,Opcodes.D2L).contains(opcode)?2:1;
                    after=probe("transform","(III)V",1,width,line);
                }else if(opcode>=Opcodes.LCMP && opcode<=Opcodes.DCMPG){
                    after=probe("transform","(III)V",2,1,line);
                }else if(opcode>=Opcodes.IRETURN && opcode<=Opcodes.RETURN){
                    before=probe("returned","(II)V",opcode==Opcodes.RETURN?0:opcode==Opcodes.LRETURN || opcode==Opcodes.DRETURN?2:1,line);
                }else if(opcode==Opcodes.NEW){
                    after=probe("value","(II)V",1,line);
                }else if(opcode==Opcodes.CHECKCAST){
                    // Successful cast preserves the exact operand identity.
                }else if(opcode==Opcodes.INSTANCEOF){
                    after=probe("opaque","(IIILjava/lang/String;)V",1,1,line,"Type predicate is not scalar value transport.");
                }else if(opcode==Opcodes.ATHROW){
                    // The actual handler or outer exception guard resets the frame.
                }else if(opcode==Opcodes.MONITORENTER || opcode==Opcodes.MONITOREXIT){
                    after=probe("discard","(II)V",1,line);
                }else if(opcode==Opcodes.NEWARRAY || opcode==Opcodes.ANEWARRAY || opcode==Opcodes.MULTIANEWARRAY){
                    after=probe("opaque","(IIILjava/lang/String;)V",node instanceof MultiANewArrayInsnNode multi?multi.dims:1,1,line,"Array allocation/element identity is not tracked.");
                }else if(opcode>=Opcodes.IALOAD && opcode<=Opcodes.SALOAD){
                    after=probe("opaque","(IIILjava/lang/String;)V",2,opcode==Opcodes.LALOAD || opcode==Opcodes.DALOAD?2:1,line,"Array element read observed; prior heap transport is unproven.");
                }else if(opcode>=Opcodes.IASTORE && opcode<=Opcodes.SASTORE){
                    after=probe("opaque","(IIILjava/lang/String;)V",3,0,line,"Array element write is outside the scalar field model.");
                }else if(opcode==Opcodes.ARRAYLENGTH){
                    after=probe("opaque","(IIILjava/lang/String;)V",1,1,line,"Array length is a derived shape observation.");
                }else if(opcode!=Opcodes.NOP)throw new IllegalArgumentException("Unknown instruction");
                method.instructions.insertBefore(node,before);method.instructions.insert(node,after);
            }
            LabelNode protectedEnd=new LabelNode(),catchAll=new LabelNode();
            method.instructions.add(protectedEnd);method.instructions.add(catchAll);
            method.instructions.add(probe("escaped","(I)V",firstLine));method.instructions.add(new InsnNode(Opcodes.ATHROW));
            method.tryCatchBlocks.add(new TryCatchBlockNode(protectedStart,protectedEnd,catchAll,null));
        }
        ClassWriter writer=new ClassWriter(ClassWriter.COMPUTE_FRAMES|ClassWriter.COMPUTE_MAXS){
            @Override protected String getCommonSuperClass(String a,String b){
                if(a.equals(b))return a;
                try{
                    // The overlay uses the system loader; no class initialization.
                    Class<?> first=Class.forName(a.replace('/','.'),false,loader),second=Class.forName(b.replace('/','.'),false,loader);
                    if(first.isAssignableFrom(second))return a;if(second.isAssignableFrom(first))return b;
                    if(first.isInterface() || second.isInterface())return "java/lang/Object";
                    do{first=first.getSuperclass();}while(!first.isAssignableFrom(second));
                    return first.getName().replace('.','/');
                }catch(Throwable failure){throw new IllegalArgumentException("Cannot prove frame type",failure);}
            }
        };
        owner.accept(writer);return writer.toByteArray();
    }
}
