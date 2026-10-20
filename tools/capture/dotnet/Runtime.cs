// Development-only, memory-bounded local capture. No user serializers or getters.
#nullable enable
namespace CbmLocalCapture
{
    internal sealed class Frame : System.IDisposable
    {
        internal readonly string Path, Hash, Symbol, Invocation;
        internal readonly System.Collections.Generic.Dictionary<string, string> Bindings = new(), Sites = new();
        internal Frame(string path, string hash, string symbol, string invocation) { Path = path; Hash = hash; Symbol = symbol; Invocation = invocation; }
        internal string[] Inputs(params string[] sites) => System.Linq.Enumerable.ToArray(System.Linq.Enumerable.Where(System.Linq.Enumerable.Select(sites, site => Sites.TryGetValue(site, out var id) ? id : ""), id => id.Length > 0));
        internal void Gap(int line, string detail) { Bindings.Clear(); Sites.Clear(); Notice(line, detail); }
        internal void Notice(int line, string detail) => Probe.Emit(this, "gap", line, System.Array.Empty<string>(), detail: detail);
        public void Dispose() { if (Symbol == "Main") Probe.Flush(); }
    }
    internal static class Probe
    {
        private static readonly object Sync = new();
        private static readonly System.Collections.Generic.Queue<System.Collections.Generic.Dictionary<string, object>> Queue = new();
        private static readonly System.Collections.Generic.HashSet<string> Fields = new(System.StringComparer.Ordinal);
        private static readonly string Producer = "dotnet-" + System.Guid.NewGuid().ToString("N");
        private static readonly System.Net.Http.HttpClient Client = new(new System.Net.Http.HttpClientHandler { AllowAutoRedirect = false, UseProxy = false }) { Timeout = System.TimeSpan.FromMilliseconds(300) };
        private static readonly System.Uri? Endpoint;
        private static readonly string Token = System.Environment.GetEnvironmentVariable("CBM_CAPTURE_TOKEN") ?? "";
        private static readonly bool Values;
        private static readonly System.Threading.Timer? Timer;
        private static long sequence, invocation;
        private static int sending;
        private static bool disabled;
        static Probe()
        {
            var address = System.Environment.GetEnvironmentVariable("CBM_CAPTURE_ENDPOINT");
            if (System.Uri.TryCreate(address, System.UriKind.Absolute, out var uri) && uri.Scheme == "http" &&
                (uri.Host == "127.0.0.1" || uri.Host == "localhost" || uri.Host == "[::1]") && uri.AbsolutePath == "/v1/cbm/lineage" &&
                uri.UserInfo.Length == 0 && uri.Fragment.Length == 0 && Token.Length > 0 && !Token.Contains('\r') && !Token.Contains('\n'))
                Endpoint = uri.Host == "localhost" ? new System.UriBuilder(uri) { Host = "127.0.0.1" }.Uri : uri;
            Values = System.Environment.GetEnvironmentVariable("CBM_CAPTURE_VALUES") == "1";
            try
            {
                var fields = System.Text.Json.JsonSerializer.Deserialize<string[]>(System.Environment.GetEnvironmentVariable("CBM_CAPTURE_FIELDS") ?? "[]") ?? System.Array.Empty<string>();
                if (fields.Length <= 64)
                    foreach (var field in fields)
                        if (field is not null && field.Length > 0 && System.Text.Encoding.UTF8.GetByteCount(field) <= 200 && !field.Contains('*') && !System.Linq.Enumerable.Any(field, c => c < 32)) Fields.Add(field);
            }
            catch { }
            if (Endpoint is not null)
            {
                Timer = new System.Threading.Timer(_ => Send(), null, 100, 100);
                System.AppDomain.CurrentDomain.ProcessExit += (_, _) => Flush();
            }
        }
        internal static Frame Enter(string path, string hash, string symbol, int line) => new(path, hash, symbol, "i" + System.Threading.Interlocked.Increment(ref invocation));
        internal static string Emit(Frame frame, string operation, int line, string[] inputs, string? access = null, object? value = null, string? detail = null)
        {
            if (Endpoint is null || disabled) return "";
            lock (Sync)
            {
                if (sequence >= 10000) return "";
                long current = ++sequence;
                var identifier = "v" + current;
                var data = new System.Collections.Generic.Dictionary<string, object>
                {
                    ["sequence"] = current, ["invocation_id"] = frame.Invocation, ["value_id"] = identifier,
                    ["operation"] = current == 10000 ? "gap" : operation,
                    ["inputs"] = current == 10000 ? System.Array.Empty<string>() : inputs,
                    ["source"] = new { file_path = frame.Path, source_hash = frame.Hash, symbol = frame.Symbol, line }
                };
                if (access is not null && access.Length > 0 && System.Text.Encoding.UTF8.GetByteCount(access) <= 200) data["access_path"] = access;
                if (detail is not null) data["detail"] = detail;
                if (current == 10000) data["detail"] = "Producer event budget reached; subsequent execution is unobserved.";
                else if (Values && access is not null && Fields.Contains(access))
                {
                    // Pattern matching on sealed builtin types does not invoke
                    // arbitrary conversion, ToString, reflection or accessors.
                    if (value is null || value is bool || value is byte || value is sbyte || value is short || value is ushort || value is int || value is uint) data["preview"] = value!;
                    else if (value is long signed && signed >= -9007199254740991 && signed <= 9007199254740991) data["preview"] = signed;
                    else if (value is ulong unsigned && unsigned <= 9007199254740991) data["preview"] = unsigned;
                    else if (value is double number && double.IsFinite(number)) data["preview"] = number;
                    else if (value is float single && float.IsFinite(single)) data["preview"] = single;
                    else if (value is string text)
                    {
                        var bytes = System.Text.Encoding.UTF8.GetBytes(text);
                        var count = System.Math.Min(bytes.Length, 256);
                        while (count > 0 && count < bytes.Length && (bytes[count] & 0xc0) == 0x80) count--;
                        data["preview"] = System.Text.Encoding.UTF8.GetString(bytes, 0, count);
                    }
                }
                Queue.Enqueue(data);
                return current < 10000 ? identifier : "";
            }
        }
        private static void Set(Frame frame, string site, string id) { if (id.Length > 0) frame.Sites[site] = id; else frame.Sites.Remove(site); }
        internal static T Value<T>(Frame frame, string site, int line, T value) { Set(frame, site, Emit(frame, "value", line, System.Array.Empty<string>())); return value; }
        internal static T Parameter<T>(Frame frame, string binding, string access, int line, T value) { frame.Bindings[binding] = Emit(frame, "value", line, System.Array.Empty<string>(), access, value); return value; }
        internal static T Read<T>(Frame frame, string site, string binding, string access, int line, T value)
        {
            var inputs = frame.Bindings.TryGetValue(binding, out var id) && id.Length > 0 ? new[] { id } : System.Array.Empty<string>();
            Set(frame, site, Emit(frame, "copy", line, inputs, access, value)); return value;
        }
        internal static T Write<T>(Frame frame, string site, string binding, string access, int line, T value, string input)
        { var id = Emit(frame, "copy", line, frame.Inputs(input), access, value); frame.Bindings[binding] = id; Set(frame, site, id); return value; }
        internal static T Operation<T>(Frame frame, string site, int line, T value, string left, string right)
        { Set(frame, site, Emit(frame, "transform", line, frame.Inputs(left, right))); return value; }
        internal static T Returned<T>(Frame frame, string site, int line, T value, string input)
        { Set(frame, site, Emit(frame, "return", line, frame.Inputs(input))); return value; }
        internal static T Forward<T>(Frame frame, string site, int line, T value, string input)
        { Set(frame, site, Emit(frame, "copy", line, frame.Inputs(input))); return value; }
        internal static T Opaque<T>(Frame frame, string site, int line, T value, string detail)
        { frame.Gap(line, detail); Set(frame, site, Emit(frame, "value", line, System.Array.Empty<string>())); return value; }
        internal static T Field<T>(Frame frame, string site, string access, int line, T value)
        { frame.Gap(line, "Field/accessor result observed once; prior object state transport is unproven."); Set(frame, site, Emit(frame, "field", line, System.Array.Empty<string>(), access, value)); return value; }
        private static void Send()
        {
            if (Endpoint is null || disabled || System.Threading.Interlocked.Exchange(ref sending, 1) != 0) return;
            try
            {
                var batch = new System.Collections.Generic.List<System.Collections.Generic.Dictionary<string, object>>();
                lock (Sync) { while (batch.Count < 128 && Queue.Count > 0) batch.Add(Queue.Dequeue()); }
                if (batch.Count == 0) return;
                var body = System.Text.Json.JsonSerializer.Serialize(new { schema_version = 1, producer = new { id = Producer, language = "csharp" }, events = batch });
                using var request = new System.Net.Http.HttpRequestMessage(System.Net.Http.HttpMethod.Post, Endpoint);
                request.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", Token);
                request.Content = new System.Net.Http.StringContent(body, System.Text.Encoding.UTF8, "application/json");
                using var response = Client.Send(request);
                if (!response.IsSuccessStatusCode) disabled = true;
            }
            catch { disabled = true; }
            finally { System.Threading.Interlocked.Exchange(ref sending, 0); }
        }
        internal static void Flush()
        {
            var clock = System.Diagnostics.Stopwatch.StartNew();
            while (clock.ElapsedMilliseconds < 1500 && !disabled)
            {
                Send();
                lock (Sync) { if (Queue.Count == 0 && System.Threading.Volatile.Read(ref sending) == 0) return; }
                System.Threading.Thread.Sleep(10);
            }
        }
    }
}
