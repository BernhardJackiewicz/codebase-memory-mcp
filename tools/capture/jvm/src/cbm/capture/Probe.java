package cbm.capture;

import java.net.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.atomic.AtomicLong;
import java.util.regex.Pattern;

/** Runtime operand identities, scoped to actual JVM threads and method entries.
 * No object equality, getters, serializers or application toString calls. */
public final class Probe {
    private record Value(String id, int width) {}
    private static final class Pending {
        final Class<?> caller;
        final String owner, name, descriptor;
        final List<Value> arguments;
        final Value receiver;
        final boolean exact;
        String returned;
        boolean entered;
        Pending(Class<?> c, String o, String n, String d, List<Value> a, Value r, boolean e) {
            caller=c;owner=o;name=n;descriptor=d;arguments=a;receiver=r;exact=e;
        }
    }
    private static final class Frame {
        final Class<?> owner;
        final String path, hash, symbol, invocation;
        final ArrayList<Value> stack = new ArrayList<>();
        final Map<Integer,Value> locals = new HashMap<>();
        Pending pending, parent;
        int line;
        Frame(Class<?> o,String p,String h,String s,int l) {
            owner=o;path=p;hash=h;symbol=s;line=l;invocation="j"+invocations.incrementAndGet();
        }
    }
    private static final ThreadLocal<ArrayDeque<Frame>> frames=ThreadLocal.withInitial(ArrayDeque::new);
    private static final AtomicLong invocations=new AtomicLong();
    private static final ArrayBlockingQueue<String> queue=new ArrayBlockingQueue<>(16);
    private static final ArrayList<String> batch=new ArrayList<>();
    private static final Set<String> allowed=new HashSet<>();
    private static final String producer="jvm-"+UUID.randomUUID();
    private static volatile boolean running, failed;
    private static boolean previews;
    private static long sequence;
    private static URL endpoint;
    private static String token;
    private static Thread sender;

    static boolean start() {
        try {
            String address=System.getenv("CBM_CAPTURE_ENDPOINT");
            token=System.getenv("CBM_CAPTURE_TOKEN");
            if(address==null || token==null || token.isBlank() || token.length()>4096) return false;
            URI uri=URI.create(address);
            String host=uri.getHost();
            if(!"http".equals(uri.getScheme()) || !Set.of("localhost","127.0.0.1","[::1]","::1").contains(host)
               || uri.getUserInfo()!=null || uri.getFragment()!=null || uri.getPort()<1
               || !"/v1/cbm/lineage".equals(uri.getPath())
               || uri.getRawQuery()==null || !uri.getRawQuery().matches("session=[0-9a-f]{32}")) return false;
            endpoint=new URI("http",null,host.equals("localhost")?"127.0.0.1":host,uri.getPort(),
                             uri.getPath(),uri.getRawQuery(),null).toURL();
            previews="1".equals(System.getenv("CBM_CAPTURE_VALUES"));
            String names=System.getenv().getOrDefault("CBM_CAPTURE_FIELDS","[]").trim();
            // Deliberately strict JSON subset: escaped names are unsupported.
            if(!names.matches("\\[\\s*(\"[^\"\\\\\\p{Cntrl}]*\"\\s*(,\\s*\"[^\"\\\\\\p{Cntrl}]*\"\\s*)*)?\\]"))
                return false;
            var matcher=Pattern.compile("\"([^\"]*)\"").matcher(names);
            while(matcher.find()) {
                String name=matcher.group(1);
                if(name.isEmpty() || name.contains("*") || name.getBytes(StandardCharsets.UTF_8).length>200 || allowed.size()>=64) return false;
                allowed.add(name);
            }
            running=true;
            sender=new Thread(Probe::send,"cbm-jvm-capture");sender.setDaemon(true);sender.start();
            java.lang.Runtime.getRuntime().addShutdownHook(new Thread(()->{
                synchronized(Probe.class){flush();}
                running=false;
                try{sender.join(1200);}catch(InterruptedException ignored){Thread.currentThread().interrupt();}
            },"cbm-jvm-capture-close"));
            return true;
        } catch(Throwable failure){ return false; }
    }

    private static void send() {
        while(running || !queue.isEmpty()) {
            try {
                synchronized(Probe.class){flush();}
                String body=queue.poll(100,java.util.concurrent.TimeUnit.MILLISECONDS);
                if(body==null)continue;
                HttpURLConnection connection=(HttpURLConnection)endpoint.openConnection(Proxy.NO_PROXY);
                connection.setConnectTimeout(300);connection.setReadTimeout(300);
                connection.setInstanceFollowRedirects(false);connection.setRequestMethod("POST");
                connection.setRequestProperty("Authorization","Bearer "+token);
                connection.setRequestProperty("Content-Type","application/json");
                connection.setDoOutput(true);
                byte[] raw=body.getBytes(StandardCharsets.UTF_8);
                connection.setFixedLengthStreamingMode(raw.length);
                try(var out=connection.getOutputStream()){out.write(raw);}
                int status=connection.getResponseCode();connection.disconnect();
                if(status<200 || status>=300){failed=true;queue.clear();}
            }catch(Throwable ignored){failed=true;queue.clear();}
        }
    }
    private static void flush() {
        if(batch.isEmpty()) return;
        String payload="{\"schema_version\":1,\"producer\":{\"id\":"+quote(producer)+",\"language\":\"jvm\"},\"events\":["+String.join(",",batch)+"]}";
        batch.clear();
        if(!queue.offer(payload)){failed=true;System.err.println("CBM JVM capture queue full; observation stopped.");}
    }
    private static String quote(String value) {
        StringBuilder out=new StringBuilder("\"");
        for(int i=0;i<value.length();i++){
            char c=value.charAt(i);
            if(c=='\"'||c=='\\')out.append('\\').append(c);
            else if(c<32 || Character.isSurrogate(c))out.append(String.format("\\u%04x",(int)c));
            else out.append(c);
        }
        return out.append('\"').toString();
    }
    private static String previewString(String text) {
        // Inspect only the bounded prefix. Re-encoding and copying the entire
        // string for every removed character is quadratic in application input.
        StringBuilder prefix=new StringBuilder(256);
        int bytes=0;
        for(int i=0;i<text.length();) {
            char first=text.charAt(i);
            int point=first, units=1;
            if(Character.isHighSurrogate(first) && i+1<text.length()
                    && Character.isLowSurrogate(text.charAt(i+1))) {
                point=Character.toCodePoint(first,text.charAt(i+1));
                units=2;
            } else if(Character.isSurrogate(first)) point=0xfffd;
            int size=point<=0x7f?1:point<=0x7ff?2:point<=0xffff?3:4;
            if(bytes+size>256)break;
            prefix.appendCodePoint(point);
            bytes+=size;
            i+=units;
        }
        return quote(prefix.toString());
    }
    private static String preview(Object object) {
        if(object==null)return "null";
        Class<?> type=object.getClass();
        if(type==String.class)return previewString((String)object);
        if(type==Boolean.class)return ((Boolean)object)?"true":"false";
        if(type==Character.class)return previewString(String.valueOf((Character)object));
        if(type==Byte.class || type==Short.class || type==Integer.class || type==Long.class) {
            long value=((Number)object).longValue();
            return value>=-9007199254740991L && value<=9007199254740991L ? Long.toString(value):null;
        }
        if(type==Float.class || type==Double.class) {
            double value=((Number)object).doubleValue();
            return Double.isFinite(value)?Double.toString(value):null;
        }
        return null;
    }
    private static synchronized String event(Frame frame,String operation,List<Value> inputs,String path,Object value,String detail) {
        if(failed || sequence>=10000)return null;
        long number=++sequence;
        if(number==10000){operation="gap";inputs=List.of();detail="Producer event budget reached; subsequent execution is unobserved.";}
        var ids=new LinkedHashSet<String>();
        for(Value input:inputs)if(input!=null && input.id!=null && ids.size()<64)ids.add(quote(input.id));
        StringBuilder out=new StringBuilder("{\"sequence\":").append(number).append(",\"operation\":").append(quote(operation))
            .append(",\"invocation_id\":").append(quote(frame.invocation)).append(",\"value_id\":\"v").append(number)
            .append("\",\"inputs\":[").append(String.join(",",ids)).append("],\"source\":{\"file_path\":")
            .append(quote(frame.path)).append(",\"source_hash\":").append(quote(frame.hash)).append(",\"line\":")
            .append(Math.max(1,frame.line)).append(",\"symbol\":").append(quote(frame.symbol)).append("}");
        if(path!=null && !path.isEmpty())out.append(",\"access_path\":").append(quote(path));
        if(detail!=null)out.append(",\"detail\":").append(quote(detail));
        if(previews && path!=null && allowed.contains(path)) {
            String p=preview(value);if(p!=null)out.append(",\"preview\":").append(p);
        }
        batch.add(out.append("}").toString());
        if(batch.size()>=128)flush();
        return operation.equals("gap")?null:"v"+number;
    }
    private static Frame frame(){return frames.get().peek();}
    private static Value pop(Frame f) {return f.stack.isEmpty()?new Value(null,1):f.stack.remove(f.stack.size()-1);}
    private static void push(Frame f,Value v) {
        if(f.stack.size()>=4096){f.stack.clear();gap(f,"Operand tracking budget reached.");}
        f.stack.add(v);
    }
    private static void gap(Frame f,String detail){event(f,"gap",List.of(),null,null,detail);}
    private static void failure(){failed=true;frames.remove();}

    public static void enter(Class<?> owner,String path,String hash,String symbol,String name,String descriptor,boolean isStatic,int line) {
        try {
            ArrayDeque<Frame> stack=frames.get();
            if(stack.size()>=256){failed=true;stack.clear();return;}
            Frame caller=stack.peek(),f=new Frame(owner,path,hash,symbol,line);
            Pending p=caller==null?null:caller.pending;
            if(p!=null && p.exact && isStatic && !p.entered && p.owner.equals(owner.getName().replace('.','/'))
               && p.name.equals(name) && p.descriptor.equals(descriptor) && p.caller.getClassLoader()==owner.getClassLoader()){
                p.entered=true;f.parent=p;
            }
            stack.push(f);
        }catch(Throwable ignored){failure();}
    }
    public static void parameter(int slot,int index,int width,String name,Object actual) {
        try{Frame f=frame();if(f==null)return;
            List<Value> inputs=f.parent!=null && index<f.parent.arguments.size()?List.of(f.parent.arguments.get(index)):List.of();
            f.locals.put(slot,new Value(event(f,"value",inputs,name,actual,null),width));
        }catch(Throwable ignored){failure();}
    }
    public static void load(int slot,int width,int line) {
        try{Frame f=frame();if(f==null)return;f.line=line;
            Value previous=f.locals.get(slot);
            push(f,new Value(event(f,"copy",previous==null?List.of():List.of(previous),null,null,null),width));
        }catch(Throwable ignored){failure();}
    }
    public static void store(int slot,int width,String name,int line,Object actual) {
        try{Frame f=frame();if(f==null)return;f.line=line;
            f.locals.put(slot,new Value(event(f,"copy",List.of(pop(f)),name,actual,null),width));
        }catch(Throwable ignored){failure();}
    }
    public static void value(int width,int line) {
        try{Frame f=frame();if(f==null)return;f.line=line;push(f,new Value(event(f,"value",List.of(),null,null,null),width));}
        catch(Throwable ignored){failure();}
    }
    public static void transform(int consumed,int width,int line) {
        try{Frame f=frame();if(f==null)return;f.line=line;List<Value> inputs=new ArrayList<>();
            for(int i=0;i<consumed;i++)inputs.add(pop(f));
            push(f,new Value(event(f,"transform",inputs,null,null,null),width));
        }catch(Throwable ignored){failure();}
    }
    public static void increment(int slot,String name,int line,Object actual) {
        try{Frame f=frame();if(f==null)return;f.line=line;Value old=f.locals.get(slot);
            f.locals.put(slot,new Value(event(f,"transform",old==null?List.of():List.of(old),name,actual,null),1));
        }catch(Throwable ignored){failure();}
    }
    public static void discard(int count,int line) {
        try{Frame f=frame();if(f==null)return;f.line=line;for(int i=0;i<count;i++)pop(f);}
        catch(Throwable ignored){failure();}
    }
    public static void opaque(int consumed,int width,int line,String detail) {
        try{Frame f=frame();if(f==null)return;f.line=line;for(int i=0;i<consumed;i++)pop(f);gap(f,detail);
            if(width>0)push(f,new Value(event(f,"value",List.of(),null,null,null),width));
        }catch(Throwable ignored){failure();}
    }
    public static void field(int opcode,int width,String name,int line,Object actual) {
        try{Frame f=frame();if(f==null)return;f.line=line;
            if(opcode==178 || opcode==180) {
                if(opcode==180)pop(f);
                gap(f,"Field read observed once; mutable heap versions and cross-thread transport are not proven.");
                push(f,new Value(event(f,"field",List.of(),name,actual,null),width));
            } else {
                Value input=pop(f);if(opcode==181)pop(f);
                event(f,"field",List.of(input),name,actual,null);
            }
        }catch(Throwable ignored){failure();}
    }
    public static void before(Class<?> caller,String owner,String name,String descriptor,int arguments,boolean exact,boolean receiver,int line) {
        try{Frame f=frame();if(f==null)return;f.line=line;
            var inputs=new ArrayList<Value>();for(int i=0;i<arguments;i++)inputs.add(0,pop(f));
            Value receiverValue=receiver?pop(f):null;
            f.pending=new Pending(caller,owner,name,descriptor,inputs,receiverValue,exact);
            event(f,"call",inputs,null,null,"Executed invocation at this bytecode callsite; return joins require an exact instrumented static target.");
        }catch(Throwable ignored){failure();}
    }
    public static void after(int width,int line) {
        try{Frame f=frame();if(f==null)return;f.line=line;Pending pending=f.pending;f.pending=null;
            String result=pending==null?null:pending.returned;
            boolean stringTransform=pending!=null && pending.receiver!=null && pending.owner.equals("java/lang/String")
                && Set.of("trim()Ljava/lang/String;","strip()Ljava/lang/String;","stripLeading()Ljava/lang/String;",
                          "stripTrailing()Ljava/lang/String;","toLowerCase()Ljava/lang/String;","toUpperCase()Ljava/lang/String;",
                          "substring(I)Ljava/lang/String;","substring(II)Ljava/lang/String;","concat(Ljava/lang/String;)Ljava/lang/String;",
                          "replace(CC)Ljava/lang/String;").contains(pending.name+pending.descriptor);
            if(stringTransform){
                var inputs=new ArrayList<Value>(pending.arguments);inputs.add(pending.receiver);
                push(f,new Value(event(f,"transform",inputs,null,null,"Executed supported final java.lang.String operation."),width));
            }else{
                if(pending==null || !pending.entered)gap(f,"Opaque or dynamic call: argument-to-result transport is not proven.");
                if(width>0)push(f,new Value(event(f,"copy",result==null?List.of():List.of(new Value(result,width)),null,null,null),width));
            }
        }catch(Throwable ignored){failure();}
    }
    public static void returned(int width,int line) {
        try{Frame f=frame();if(f==null)return;f.line=line;
            String id=event(f,"return",width>0?List.of(pop(f)):List.of(),null,null,null);
            if(f.parent!=null)f.parent.returned=width>0?id:null;
            frames.get().pop();
        }catch(Throwable ignored){failure();}
    }
    public static void caught(int line) {
        try{Frame f=frame();if(f==null)return;f.line=line;f.stack.clear();f.pending=null;
            gap(f,"Exception handler entered; pending call and operand stack reset.");
            push(f,new Value(event(f,"value",List.of(),null,null,null),1));
        }catch(Throwable ignored){failure();}
    }
    public static void escaped(int line) {
        try{Frame f=frame();if(f==null)return;f.line=line;gap(f,"Invocation exited by exception; no normal return transport.");frames.get().pop();}
        catch(Throwable ignored){failure();}
    }
    public static void skipped(String path,String hash,String symbol,int line,String detail) {
        try{gap(new Frame(Probe.class,path,hash,symbol,line),detail);}catch(Throwable ignored){failure();}
    }
    public static void stack(int opcode) {
        try{Frame f=frame();if(f==null)return;Value a=pop(f),b,c,d;
            switch(opcode){
                case 87:break; // POP
                case 88:if(a.width==1)pop(f);break;
                case 89:push(f,a);push(f,a);break;
                case 90:b=pop(f);push(f,a);push(f,b);push(f,a);break;
                case 91:b=pop(f);if(b.width==2){push(f,a);push(f,b);push(f,a);}
                    else{c=pop(f);push(f,a);push(f,c);push(f,b);push(f,a);}break;
                case 92:if(a.width==2){push(f,a);push(f,a);}else{b=pop(f);push(f,b);push(f,a);push(f,b);push(f,a);}break;
                case 93:if(a.width==2){b=pop(f);push(f,a);push(f,b);push(f,a);}
                    else{b=pop(f);c=pop(f);push(f,b);push(f,a);push(f,c);push(f,b);push(f,a);}break;
                case 94:
                    b=pop(f);
                    if(a.width==2){if(b.width==2){push(f,a);push(f,b);push(f,a);}
                        else{c=pop(f);push(f,a);push(f,c);push(f,b);push(f,a);}}
                    else{c=pop(f);if(c.width==2){push(f,b);push(f,a);push(f,c);push(f,b);push(f,a);}
                        else{d=pop(f);push(f,b);push(f,a);push(f,d);push(f,c);push(f,b);push(f,a);}}break;
                case 95:b=pop(f);push(f,a);push(f,b);break;
                default:gap(f,"Unsupported stack instruction.");f.stack.clear();
            }
        }catch(Throwable ignored){failure();}
    }
}
