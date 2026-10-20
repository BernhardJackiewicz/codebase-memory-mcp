use proc_macro2::{Ident, Span};
use quote::{quote, ToTokens};
use std::collections::HashMap;
use syn::{parse_quote, spanned::Spanned, visit_mut::{self, VisitMut}, BinOp, Expr, FnArg, Item, Pat, ReturnType, Stmt, Type};

#[derive(Clone)]
enum Kind { Scalar, Structure(String), Unknown }
#[derive(Clone)]
struct Binding { id: String, kind: Kind }
struct Context<'a> {
    frame: Ident, scopes: Vec<HashMap<String, Binding>>,
    structures: &'a HashMap<String, HashMap<String, Kind>>,
    unproven_lifetimes: bool,
}
// This is a closed syntax check, not a guess about whether a named type has Drop.
// Unknown owned bindings are checked separately when their kinds are inferred.
// Calls/methods, borrows, macros and other unsupported forms can create values
// whose destructors run after a probe, at a statement/scope end or replacement.
#[derive(Default)]
struct LifetimeRisk { unproven: bool }
impl VisitMut for LifetimeRisk {
    fn visit_expr_mut(&mut self, expr: &mut Expr) {
        match expr {
            Expr::Unary(unary) if matches!(unary.op, syn::UnOp::Deref(_)) => self.unproven = true,
            Expr::Lit(_) | Expr::Path(_) | Expr::Paren(_) | Expr::Group(_) |
            Expr::Cast(_) | Expr::Unary(_) | Expr::Binary(_) | Expr::Assign(_) |
            Expr::Block(_) | Expr::If(_) | Expr::Return(_) | Expr::Field(_) => {
                visit_mut::visit_expr_mut(self, expr);
            },
            _ => self.unproven = true,
        }
    }
    fn visit_stmt_mut(&mut self, stmt: &mut Stmt) {
        if matches!(stmt, Stmt::Item(_) | Stmt::Macro(_)) { self.unproven = true; }
        else { visit_mut::visit_stmt_mut(self, stmt); }
    }
}
fn unproven_temporary(expr: &Expr) -> bool {
    let mut risk = LifetimeRisk::default();
    risk.visit_expr_mut(&mut expr.clone());
    risk.unproven
}
fn key(node: &impl Spanned) -> String { let p = node.span().start(); format!("{}:{}", p.line, p.column) }
fn line(node: &impl Spanned) -> usize { node.span().start().line.max(1) }
fn type_kind(ty: &Type) -> Kind {
    match ty {
        Type::Path(path) if path.qself.is_none() && path.path.segments.len() == 1 => {
            let name = path.path.segments[0].ident.to_string();
            if ["i8","i16","i32","i64","isize","u8","u16","u32","u64","usize","f32","f64","bool","char"].contains(&name.as_str()) { Kind::Scalar }
            else { Kind::Structure(name) }
        },
        Type::Reference(reference) if reference.mutability.is_none() && matches!(&*reference.elem, Type::Path(p) if p.path.is_ident("str")) => Kind::Scalar,
        _ => Kind::Unknown,
    }
}
impl Context<'_> {
    fn binding(&self, name: &str) -> Option<Binding> { self.scopes.iter().rev().find_map(|scope| scope.get(name).cloned()) }
    fn infer(&self, expr: &Expr) -> Kind {
        match expr {
            Expr::Lit(literal) => match &literal.lit { syn::Lit::Int(_) | syn::Lit::Float(_) | syn::Lit::Bool(_) | syn::Lit::Char(_) | syn::Lit::Str(_) => Kind::Scalar, _ => Kind::Unknown },
            Expr::Path(p) if p.qself.is_none() && p.path.segments.len() == 1 => self.binding(&p.path.segments[0].ident.to_string()).map(|b| b.kind).unwrap_or(Kind::Unknown),
            Expr::Paren(p) => self.infer(&p.expr),
            Expr::Group(p) => self.infer(&p.expr),
            Expr::Cast(c) => type_kind(&c.ty),
            Expr::Unary(u) if !matches!(u.op, syn::UnOp::Deref(_)) => self.infer(&u.expr),
            Expr::Binary(b) if matches!(self.infer(&b.left), Kind::Scalar) && matches!(self.infer(&b.right), Kind::Scalar) => Kind::Scalar,
            Expr::Binary(b) if matches!(b.op, BinOp::And(_) | BinOp::Or(_)) => Kind::Scalar,
            // A lexical name cannot prove the callable behind a shadow/import.
            // Explicit primitive declaration/return types may still observe its result.
            Expr::Call(_) => Kind::Unknown,
            Expr::Field(field) => if let Kind::Structure(name) = self.infer(&field.base) {
                self.structures.get(&name).and_then(|fields| fields.get(&field.member.to_token_stream().to_string())).cloned().unwrap_or(Kind::Unknown)
            } else { Kind::Unknown },
            Expr::Struct(value) if value.path.segments.len() == 1 => Kind::Structure(value.path.segments[0].ident.to_string()),
            _ => Kind::Unknown,
        }
    }
    fn gap(&self, at: usize, message: &str) -> Stmt { let frame = &self.frame; parse_quote!(#frame.gap(#at, #message);) }
    fn expression(&mut self, expr: Expr, forced_scalar: bool) -> Expr {
        let site = key(&expr); let at = line(&expr); let frame = self.frame.clone();
        let scalar = forced_scalar || matches!(self.infer(&expr), Kind::Scalar);
        if !scalar { return expr; }
        match expr {
            Expr::Path(ref path) if path.path.segments.len() == 1 => {
                let name = path.path.segments[0].ident.to_string();
                if let Some(binding) = self.binding(&name) {
                    if matches!(binding.kind, Kind::Scalar) {
                        let id = binding.id; return parse_quote!(#frame.read(#site,#at,#id,#name,#expr));
                    }
                }
                self.unproven_lifetimes = true;
                parse_quote!(#frame.opaque(#site,#at,#expr,None,"value","External binding has no proven local scalar identity."))
            },
            Expr::Lit(_) => parse_quote!(#frame.observe(#site,#at,#expr,&[],"value")),
            Expr::Paren(mut p) => {
                let child = key(&*p.expr); p.expr = Box::new(self.expression(*p.expr, false));
                parse_quote!(#frame.observe(#site,#at,#p,&[#child],"copy"))
            },
            Expr::Binary(mut binary) if !matches!(binary.op, BinOp::And(_) | BinOp::Or(_))
                && matches!(self.infer(&binary.left), Kind::Scalar) && matches!(self.infer(&binary.right), Kind::Scalar)
                && !matches!(binary.op, BinOp::AddAssign(_) | BinOp::SubAssign(_) | BinOp::MulAssign(_) | BinOp::DivAssign(_) | BinOp::RemAssign(_) | BinOp::BitXorAssign(_) | BinOp::BitAndAssign(_) | BinOp::BitOrAssign(_) | BinOp::ShlAssign(_) | BinOp::ShrAssign(_)) => {
                let left = key(&*binary.left); let right = key(&*binary.right);
                binary.left = Box::new(self.expression(*binary.left, false)); binary.right = Box::new(self.expression(*binary.right, false));
                parse_quote!(#frame.observe(#site,#at,#binary,&[#left,#right],"transform"))
            },
            Expr::Unary(mut unary) if !matches!(unary.op, syn::UnOp::Deref(_)) && matches!(self.infer(&unary.expr), Kind::Scalar) => {
                let input = key(&*unary.expr); unary.expr = Box::new(self.expression(*unary.expr, false));
                parse_quote!(#frame.observe(#site,#at,#unary,&[#input],"transform"))
            },
            Expr::Field(ref field) => {
                self.unproven_lifetimes = true;
                let access = field.to_token_stream().to_string().replace(' ', "");
                parse_quote!(#frame.opaque(#site,#at,#expr,Some(#access),"field","Primitive struct field observed; prior heap/ownership lineage is unproven."))
            },
            _ => {
                if !matches!(&expr, Expr::Binary(binary) if matches!(binary.op, BinOp::And(_) | BinOp::Or(_))) {
                    self.unproven_lifetimes = true;
                }
                parse_quote!(#frame.opaque(#site,#at,#expr,None,"value","Call, short-circuit, cast or unsupported expression transport is unproven."))
            },
        }
    }
    fn block(&mut self, block: &mut syn::Block, returns_scalar: bool, tail_return: bool) {
        self.scopes.push(HashMap::new());
        let original = std::mem::take(&mut block.stmts); let length = original.len(); let mut output = Vec::new();
        for (index, stmt) in original.into_iter().enumerate() {
            let at = line(&stmt); let site = key(&stmt); let frame = self.frame.clone();
            match stmt {
                Stmt::Local(mut local) => {
                    let (name, declared) = match &local.pat {
                        Pat::Ident(pat) if pat.by_ref.is_none() && pat.subpat.is_none() => (Some(pat.ident.to_string()), None),
                        Pat::Type(typed) => if let Pat::Ident(pat) = &*typed.pat {
                            if pat.by_ref.is_none() && pat.subpat.is_none() { (Some(pat.ident.to_string()), Some(type_kind(&typed.ty))) } else { (None, None) }
                        } else { (None, None) },
                        _ => (None, None),
                    };
                    if let Some(name) = name {
                        let kind = declared.unwrap_or_else(|| local.init.as_ref().map(|init| self.infer(&init.expr)).unwrap_or(Kind::Unknown));
                        if matches!(kind, Kind::Scalar) && local.init.as_ref().map(|init| init.diverge.is_none()).unwrap_or(false) {
                            let init = local.init.as_mut().unwrap();
                            if unproven_temporary(&init.expr) {
                                // Wrapping a let initializer can remove Rust's temporary
                                // lifetime extension. Keep it intact and copy only the
                                // proven scalar binding after the original statement.
                                self.unproven_lifetimes = true;
                                let ident = match &local.pat {
                                    Pat::Ident(pat) => pat.ident.clone(),
                                    Pat::Type(typed) => match &*typed.pat {
                                        Pat::Ident(pat) => pat.ident.clone(),
                                        _ => unreachable!(),
                                    },
                                    _ => unreachable!(),
                                };
                                output.push(Stmt::Local(local));
                                output.push(parse_quote!(#frame.parameter(#site,#at,#name,#ident);));
                                self.scopes.last_mut().unwrap().insert(name, Binding { id: site, kind });
                                continue;
                            }
                            let input = key(&*init.expr); let expr = self.expression((*init.expr).clone(), true);
                            init.expr = Box::new(parse_quote!(#frame.assign(#site,#at,#site,#name,#input,#expr)));
                        } else {
                            self.unproven_lifetimes = true;
                            output.push(self.gap(at,"Non-scalar, uninitialized or complex binding has no proven ownership/value transport."));
                        }
                        self.scopes.last_mut().unwrap().insert(name, Binding { id: site, kind });
                    } else {
                        self.unproven_lifetimes = true;
                        output.push(self.gap(at,"Pattern binding is outside scalar capture coverage."));
                    }
                    output.push(Stmt::Local(local));
                },
                Stmt::Expr(Expr::Block(mut nested), semi) => {
                    self.block(&mut nested.block, returns_scalar, false);
                    output.push(Stmt::Expr(Expr::Block(nested), semi));
                },
                Stmt::Expr(Expr::Assign(mut assign), semi) => {
                    let target = if let Expr::Path(path) = &*assign.left {
                        if path.path.segments.len() == 1 { Some(path.path.segments[0].ident.to_string()) } else { None }
                    } else { None };
                    if let Some((name, binding)) = target.and_then(|name| self.binding(&name).map(|binding| (name,binding))) {
                        if matches!(binding.kind, Kind::Scalar) {
                            let input = key(&*assign.right); let value = self.expression(*assign.right, true); let id = binding.id;
                            assign.right = Box::new(parse_quote!(#frame.assign(#site,#at,#id,#name,#input,#value)));
                            output.push(Stmt::Expr(Expr::Assign(assign),semi)); continue;
                        }
                    }
                    output.push(self.gap(at,"Ownership, indirect or unsupported write invalidates scalar versions."));
                    output.push(Stmt::Expr(Expr::Assign(assign),semi));
                },
                Stmt::Expr(Expr::Return(mut returned), semi) if returns_scalar => {
                    if let Some(value) = returned.expr {
                        let input = key(&*value); let transformed = self.expression(*value,true);
                        returned.expr = Some(Box::new(parse_quote!(#frame.returning(#site,#at,#input,#transformed))));
                    }
                    output.push(Stmt::Expr(Expr::Return(returned),semi));
                },
                Stmt::Expr(Expr::If(branch), None) if tail_return && index+1 == length && returns_scalar => {
                    output.push(self.gap(at,"Conditional return transport is outside scalar capture coverage."));
                    let expr=Expr::If(branch); let input=key(&expr); let value=self.expression(expr,true);
                    output.push(Stmt::Expr(parse_quote!(#frame.returning(#site,#at,#input,#value)),None));
                },
                Stmt::Expr(Expr::If(mut branch), semi) => {
                    // Keep the exact condition and branch semantics. Each taken body records
                    // its own assignments. Unknown condition side effects invalidate versions.
                    output.push(self.gap(at,"Control condition may mutate state; branch dependence is not a value edge."));
                    self.block(&mut branch.then_branch, returns_scalar, false);
                    if let Some((_, other)) = &mut branch.else_branch {
                        if let Expr::Block(block) = &mut **other { self.block(&mut block.block, returns_scalar, false); }
                    }
                    output.push(Stmt::Expr(Expr::If(branch),semi));
                    output.push(self.gap(at,"Conditional branch completed; unmodeled branch values remain unknown."));
                },
                Stmt::Expr(expr, None) if tail_return && index+1 == length && returns_scalar => {
                    let input = key(&expr); let value = self.expression(expr,true);
                    output.push(Stmt::Expr(parse_quote!(#frame.returning(#site,#at,#input,#value)),None));
                },
                other => {
                    output.push(self.gap(at,"Macro, loop, closure, borrow or unsupported statement is outside value capture coverage."));
                    let terminal = matches!(&other, Stmt::Expr(_,None)) && index+1 == length;
                    output.push(other);
                    if !terminal { output.push(self.gap(at,"Unsupported statement completed; prior binding versions are invalidated.")); }
                },
            }
        }
        block.stmts = output; self.scopes.pop();
    }
}
fn instrument_items(items: &mut Vec<Item>, file: &str, hash: &str, helper: &Ident, module: &str) {
    let mut structures = HashMap::new(); let mut returns = HashMap::new();
    for item in items.iter() {
        if let Item::Struct(value) = item {
            let fields = value.fields.iter().enumerate().map(|(index, field)| (field.ident.as_ref().map(ToString::to_string).unwrap_or(index.to_string()),type_kind(&field.ty))).collect();
            structures.insert(value.ident.to_string(),fields);
        }
        if let Item::Fn(function) = item {
            returns.insert(function.sig.ident.to_string(),match &function.sig.output { ReturnType::Type(_,ty) => type_kind(ty), _ => Kind::Unknown });
        }
    }
    for item in items.iter_mut() {
        match item {
            Item::Mod(value) => if let Some((_,content)) = &mut value.content { instrument_items(content,file,hash,helper,&format!("{}{}::",module,value.ident)); },
            Item::Fn(function) if function.sig.constness.is_none() && function.sig.asyncness.is_none()
                && function.sig.unsafety.is_none() && function.sig.generics.params.is_empty() => {
                let symbol = format!("{}{}",module,function.sig.ident); let frame = Ident::new(&format!("{}_frame",helper),Span::call_site());
                let mut lifetime_risk = LifetimeRisk::default();
                lifetime_risk.visit_block_mut(&mut function.block);
                let mut context = Context { frame: frame.clone(), scopes: vec![HashMap::new()], structures: &structures,
                    unproven_lifetimes: lifetime_risk.unproven };
                let mut entry: Vec<Stmt> = Vec::new();
                for argument in function.sig.inputs.iter() {
                    if let FnArg::Typed(arg) = argument {
                        if let Pat::Ident(pat) = &*arg.pat {
                            if pat.by_ref.is_none() && pat.subpat.is_none() {
                                let name = pat.ident.to_string(); let binding = key(pat); let at = line(arg); let ident = &pat.ident;
                                let kind = type_kind(&arg.ty);
                                if matches!(kind,Kind::Scalar) { entry.push(parse_quote!(#frame.parameter(#binding,#at,#name,#ident);)); }
                                else {
                                    context.unproven_lifetimes = true;
                                    entry.push(context.gap(at,"Non-scalar parameter ownership/borrows are not tracked."));
                                }
                                context.scopes[0].insert(name,Binding {id:binding,kind});
                            } else { context.unproven_lifetimes = true; }
                        } else { context.unproven_lifetimes = true; }
                    }
                }
                let return_scalar = matches!(returns.get(&function.sig.ident.to_string()),Some(Kind::Scalar));
                context.block(&mut function.block,return_scalar,true);
                let proven_lifetimes = !context.unproven_lifetimes;
                entry.insert(0,parse_quote!(let #frame=crate::#helper::Frame::new(#file,#hash,#symbol,#proven_lifetimes);));
                if !proven_lifetimes {
                    entry.insert(1,context.gap(line(&function.sig),
                        "Function lifetime effects are unproven; scalar observations have no explicit inputs because scope, replacement or temporary Drop may mutate state."));
                }
                entry.append(&mut function.block.stmts); function.block.stmts=entry;
            },
            _ => {},
        }
    }
}
fn main() -> Result<(),Box<dyn std::error::Error>> {
    let args:Vec<String>=std::env::args().collect();
    if args.len()!=5 { return Err("Expected relative path, original SHA, helper identifier and source file".into()); }
    let source=std::fs::read_to_string(&args[4])?;
    if source.len()>4*1024*1024 { return Err("Source exceeds 4 MiB".into()); }
    let mut parsed=syn::parse_file(&source)?;
    let helper=syn::parse_str::<Ident>(&args[3])?;
    instrument_items(&mut parsed.items,&args[1],&args[2],&helper,"");
    println!("{}",quote!(#parsed)); Ok(())
}
