// Unix development runtime, std only. Values never cross a generic Display/Debug implementation.
use std::cell::RefCell;
use std::collections::HashMap;
use std::io::Write;
use std::os::unix::net::UnixStream;
use std::sync::Mutex;
use std::time::Duration;

struct State { socket: Option<UnixStream>, sequence: usize, invocation: usize, fields: Vec<String>, values: bool, producer: String }
static STATE: Mutex<Option<State>> = Mutex::new(None);
fn state() -> std::sync::MutexGuard<'static, Option<State>> {
    let mut guard = STATE.lock().unwrap_or_else(|poison| poison.into_inner());
    if guard.is_none() {
        let socket = std::env::var("CBM_CAPTURE_RUST_SOCKET").ok().and_then(|path| UnixStream::connect(path).ok());
        if let Some(ref stream) = socket { let _ = stream.set_write_timeout(Some(Duration::from_millis(100))); }
        *guard = Some(State { socket, sequence: 0, invocation: 0,
            fields: std::env::var("CBM_CAPTURE_RUST_FIELDS").unwrap_or_default().lines().map(str::to_owned).collect(),
            values: std::env::var("CBM_CAPTURE_VALUES").as_deref() == Ok("1"),
            producer: format!("{}:{}:{}:{}", std::env::var("CBM_CAPTURE_RUST_PRODUCER").unwrap_or_default(),
                "__CBM_CRATE_ID__", std::process::id(),
                std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d|d.as_nanos()).unwrap_or(0)) });
    }
    guard
}
fn string(value: &str) -> String {
    let mut out = String::from("\"");
    for c in value.chars() {
        match c { '"' => out.push_str("\\\""), '\\' => out.push_str("\\\\"), '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"), '\t' => out.push_str("\\t"),
            c if c < ' ' => out.push_str(&format!("\\u{:04x}", c as u32)), c => out.push(c) }
    }
    out.push('"'); out
}
mod sealed { pub trait Sealed {} }
pub trait Scalar: Copy + sealed::Sealed { fn preview(self) -> Option<String>; }
macro_rules! integer {
    ($($kind:ty),*) => { $(impl sealed::Sealed for $kind {}
        impl Scalar for $kind { fn preview(self) -> Option<String> {
            let number = self as i128;
            if number.abs() <= 9007199254740991 { Some(self.to_string()) } else { None }
        } })* };
}
integer!(i8,i16,i32,i64,isize,u8,u16,u32,u64,usize);
macro_rules! float { ($($kind:ty),*) => { $(impl sealed::Sealed for $kind {} impl Scalar for $kind {
    fn preview(self) -> Option<String> { if self.is_finite() { Some(self.to_string()) } else { None } }
})* }; }
float!(f32,f64);
impl sealed::Sealed for bool {} impl Scalar for bool { fn preview(self) -> Option<String> { Some(self.to_string()) } }
impl sealed::Sealed for char {} impl Scalar for char { fn preview(self) -> Option<String> { Some(string(&self.to_string())) } }
impl<'a> sealed::Sealed for &'a str {} impl<'a> Scalar for &'a str {
    fn preview(self) -> Option<String> { Some(string(&self.chars().take(64).collect::<String>())) }
}

pub struct Frame {
    path: &'static str, hash: &'static str, symbol: &'static str, invocation: usize,
    proven_lifetimes: bool,
    bindings: RefCell<HashMap<&'static str, String>>, sites: RefCell<HashMap<&'static str, String>>,
}
impl Frame {
    pub fn new(path: &'static str, hash: &'static str, symbol: &'static str, proven_lifetimes: bool) -> Self {
        let mut guard = state(); let current = guard.as_mut().unwrap();
        current.invocation += 1;
        Self { path, hash, symbol, invocation: current.invocation, proven_lifetimes, bindings: RefCell::new(HashMap::new()), sites: RefCell::new(HashMap::new()) }
    }
    fn emit(&self, operation: &str, line: usize, inputs: Vec<String>, field: Option<&str>, preview: Option<String>, detail: Option<&str>) -> Option<String> {
        // A scalar may have changed through an unobserved destructor since its
        // last version. Keep actual observations, but never assert that edge.
        let inputs = if self.proven_lifetimes { inputs } else { Vec::new() };
        let mut guard = state(); let current = guard.as_mut().unwrap();
        if current.sequence >= 10000 || current.socket.is_none() { return None; }
        current.sequence += 1;
        let id = format!("v{}", current.sequence);
        let operation = if current.sequence == 10000 { "gap" } else { operation };
        let detail = if current.sequence == 10000 { Some("Producer event budget reached; further execution is unobserved.") } else { detail };
        let mut event = format!("{{\"sequence\":{},\"operation\":{},\"invocation_id\":\"i{}\",\"value_id\":{},\"inputs\":[{}],\"source\":{{\"file_path\":{},\"source_hash\":{},\"symbol\":{},\"line\":{}}}",
            current.sequence, string(operation), self.invocation, string(&id),
            inputs.iter().take(64).map(|s| string(s)).collect::<Vec<_>>().join(","),
            string(self.path), string(self.hash), string(self.symbol), line.max(1));
        if let Some(field) = field { event.push_str(&format!(",\"access_path\":{}", string(field))); }
        if current.values && field.map(|value| current.fields.iter().any(|f| f == value)).unwrap_or(false) {
            if let Some(preview) = preview { event.push_str(&format!(",\"preview\":{}", preview)); }
        }
        if let Some(detail) = detail { event.push_str(&format!(",\"detail\":{}", string(detail))); }
        event.push('}');
        let packet = format!("{{\"producer\":{},\"event\":{}}}\n", string(&current.producer), event);
        if current.socket.as_mut().unwrap().write_all(packet.as_bytes()).is_err() { current.socket = None; return None; }
        if operation == "gap" { None } else { Some(id) }
    }
    fn preview<T: Scalar>(&self, value: T, field: Option<&str>) -> Option<String> {
        let guard = state(); let current = guard.as_ref().unwrap();
        if current.values && field.map(|field| current.fields.iter().any(|allowed| field == allowed)).unwrap_or(false) { value.preview() } else { None }
    }
    fn save(&self, site: &'static str, id: Option<String>) {
        if let Some(id) = id { self.sites.borrow_mut().insert(site, id); } else { self.sites.borrow_mut().remove(site); }
    }
    pub fn parameter<T: Scalar>(&self, binding: &'static str, line: usize, field: &'static str, value: T) {
        if let Some(id) = self.emit("value", line, vec![], Some(field), self.preview(value, Some(field)), None) {
            self.bindings.borrow_mut().insert(binding, id);
        }
    }
    pub fn observe<T: Scalar>(&self, site: &'static str, line: usize, value: T, input_sites: &[&str], operation: &str) -> T {
        let inputs = input_sites.iter().filter_map(|site| self.sites.borrow().get(site).cloned()).collect();
        self.save(site, self.emit(operation, line, inputs, None, None, None)); value
    }
    pub fn read<T: Scalar>(&self, site: &'static str, line: usize, binding: &'static str, field: &'static str, value: T) -> T {
        let inputs = self.bindings.borrow().get(binding).cloned().into_iter().collect();
        self.save(site, self.emit("copy", line, inputs, Some(field), self.preview(value, Some(field)), None)); value
    }
    pub fn assign<T: Scalar>(&self, site: &'static str, line: usize, binding: &'static str, field: &'static str, input_site: &'static str, value: T) -> T {
        let inputs = self.sites.borrow().get(input_site).cloned().into_iter().collect();
        let id = self.emit("copy", line, inputs, Some(field), self.preview(value, Some(field)), None);
        if let Some(ref id) = id { self.bindings.borrow_mut().insert(binding, id.clone()); }
        else { self.bindings.borrow_mut().remove(binding); }
        self.save(site, id); value
    }
    pub fn returning<T: Scalar>(&self, site: &'static str, line: usize, input_site: &'static str, value: T) -> T {
        let inputs = self.sites.borrow().get(input_site).cloned().into_iter().collect();
        self.save(site, self.emit("return", line, inputs, None, None, None)); value
    }
    pub fn gap(&self, line: usize, detail: &str) {
        self.bindings.borrow_mut().clear(); self.sites.borrow_mut().clear();
        self.emit("gap", line, vec![], None, None, Some(detail));
    }
    pub fn opaque<T: Scalar>(&self, site: &'static str, line: usize, value: T, field: Option<&str>, operation: &str, detail: &str) -> T {
        self.gap(line, detail);
        self.save(site, self.emit(operation, line, vec![], field, self.preview(value, field), None)); value
    }
}
