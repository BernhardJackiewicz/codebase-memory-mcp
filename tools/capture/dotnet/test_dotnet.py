"""Real Roslyn overlay/build/runtime acceptance. Uses a caller-provided local SDK."""
import hashlib
import http.server
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import threading
import time
import unittest

HERE = Path(__file__).resolve().parent
DOTNET = os.environ.get('CBM_TEST_DOTNET') or shutil.which('dotnet')

@unittest.skipUnless(DOTNET, 'Provide CBM_TEST_DOTNET or an installed .NET 10 SDK')
class DotnetCaptureTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tool = tempfile.TemporaryDirectory(prefix='cbm-csharp-tool-')
        cls.work = Path(cls.tool.name)
        cls.env = {**os.environ, 'DOTNET_CLI_HOME': str(cls.work / 'cli'), 'NUGET_PACKAGES': str(cls.work / 'nuget'), 'DOTNET_CLI_TELEMETRY_OPTOUT': '1', 'DOTNET_NOLOGO': '1', 'DOTNET_SKIP_FIRST_TIME_EXPERIENCE': '1'}
        for name in ('CaptureTool.csproj', 'Program.cs', 'NuGet.Config'):
            shutil.copy2(HERE / name, cls.work / name)
        if (HERE / 'Runtime.cs').exists():
            shutil.copy2(HERE / 'Runtime.cs', cls.work / 'Runtime.cs')
        built = subprocess.run([DOTNET, 'build', str(cls.work / 'CaptureTool.csproj'), '--nologo', '-v:q'], capture_output=True, text=True, env=cls.env, timeout=120)
        if built.returncode:
            raise AssertionError(built.stdout + built.stderr)
        cls.executable = cls.work / 'bin/Debug/net10.0/CaptureTool.dll'

    @classmethod
    def tearDownClass(cls):
        cls.tool.cleanup()

    def capture(self, source, fields=(), values=False):
        received = []
        class Receiver(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                received.extend(json.loads(self.rfile.read(int(self.headers['Content-Length'])))['events'])
                self.send_response(200); self.end_headers(); self.wfile.write(b'{}')
            def log_message(self, *args):
                pass
        server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Receiver)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with tempfile.TemporaryDirectory(prefix='cbm-csharp-case-') as directory:
                root = Path(directory)
                project = root / 'original'; project.mkdir()
                (project / 'Program.cs').write_text(source)
                (project / 'App.csproj').write_text('<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net10.0</TargetFramework><ImplicitUsings>enable</ImplicitUsings><NuGetAudit>false</NuGetAudit></PropertyGroup></Project>')
                shutil.copy2(HERE / 'NuGet.Config', project / 'NuGet.Config')
                before = {path.name: path.read_bytes() for path in project.iterdir()}
                original = subprocess.run([DOTNET, 'run', '--project', str(project / 'App.csproj'), '-v:q'], capture_output=True, text=True, env=self.env, timeout=90)
                self.assertEqual(original.returncode, 0, original.stdout + original.stderr)
                out = root / 'overlay'
                prepared = subprocess.run([DOTNET, str(self.executable), '--root', str(project), '--out', str(out)], capture_output=True, text=True, env=self.env, timeout=60)
                self.assertEqual(prepared.returncode, 0, prepared.stdout + prepared.stderr)
                runtime_env = {**self.env, 'CBM_CAPTURE_ENDPOINT': 'http://127.0.0.1:%d/v1/cbm/lineage?session=test' % server.server_port,
                               'CBM_CAPTURE_TOKEN': 'test-token', 'CBM_CAPTURE_VALUES': '1' if values else '0', 'CBM_CAPTURE_FIELDS': json.dumps(fields)}
                observed = subprocess.run([DOTNET, 'run', '--project', str(out / 'App.csproj'), '-v:q'], capture_output=True, text=True, env=runtime_env, timeout=90)
                self.assertEqual(observed.returncode, original.returncode, observed.stdout + observed.stderr)
                self.assertEqual(observed.stdout, original.stdout)
                self.assertEqual(before, {name: (project / name).read_bytes() for name in before})
                self.assertTrue(received, 'No automatic runtime observations received')
                self.assertTrue(all(event['source']['source_hash'] == hashlib.sha256(source.encode()).hexdigest() for event in received))
                self.assertTrue(all(event['sequence'] == index + 1 for index, event in enumerate(received)))
                return observed.stdout, received
        finally:
            server.shutdown(); server.server_close(); thread.join(timeout=2)

    def test_scalar_copies_transform_overwrite_and_return_are_real_events(self):
        source = '''using System;
class Program {
 static string Flow(string email) {
   string copied = email;
   string changed = copied + ".test";
   copied = "overwritten";
   return changed;
 }
 static void Main() { Console.WriteLine(Flow("sample@example")); }
}
'''
        _, events = self.capture(source)
        self.assertTrue(any(e['operation'] == 'copy' and e['inputs'] for e in events))
        self.assertTrue(any(e['operation'] == 'transform' and len(e['inputs']) == 2 for e in events))
        self.assertTrue(any(e['operation'] == 'return' and e['inputs'] for e in events))
        self.assertFalse(any('preview' in e for e in events))

    def test_accessor_once_exception_order_short_circuit_and_exact_preview(self):
        source = '''using System;
class Profile { public static int Reads; public string Email { get { Reads++; return "sample@example.test"; } } }
class Program {
 static string Flow(Profile profile) {
   string email = profile.Email;
   bool unused = false && Throw();
   return email;
 }
 static bool Throw() { throw new Exception("must not run"); }
 static void Main() { Console.WriteLine(Flow(new Profile())); Console.WriteLine(Profile.Reads); }
}
'''
        output, events = self.capture(source, fields=['profile.Email'], values=True)
        self.assertEqual(output, 'sample@example.test\n1\n')
        previews = [e for e in events if 'preview' in e]
        self.assertTrue(previews)
        self.assertTrue(all(e['access_path'] == 'profile.Email' and e['preview'] == 'sample@example.test' for e in previews))
        self.assertTrue(any(e['operation'] == 'gap' for e in events))

    def test_shadow_scopes_ref_values_and_async_remain_compilable(self):
        source = '''using System;
using System.Threading.Tasks;
class Program {
 static async Task<string> Flow(string email) { await Task.Yield(); return email; }
 static void Update(ref int number) { number++; }
 static void Main() {
   int number = 2; Update(ref number);
   { string email = "inner"; Console.WriteLine(email); }
   Console.WriteLine(Flow("async").GetAwaiter().GetResult()); Console.WriteLine(number);
 }
}
'''
        output, events = self.capture(source)
        self.assertEqual(output, 'inner\nasync\n3\n')
        self.assertTrue(any(e['operation'] == 'gap' for e in events))

    def test_modern_top_level_program_has_actual_binding_observations(self):
        source = '''using System;
string email = "top@example.test";
string copied = email;
Console.WriteLine(copied);
'''
        output, events = self.capture(source)
        self.assertEqual(output, 'top@example.test\n')
        self.assertTrue(any(e['operation'] == 'copy' and e['inputs'] for e in events))

    def test_constant_patterns_and_parenthesized_values_preserve_semantics(self):
        source = '''using System;
class Program {
 static string Flow(int number, string email) {
   string copied = (email);
   bool matches = number is 5;
   string result = number switch { 5 => copied, _ => "other" };
   Console.WriteLine(matches);
   return result;
 }
 static void Main() { Console.WriteLine(Flow(5, "sample@example.test")); }
}
'''
        output, events = self.capture(source)
        self.assertEqual(output, 'True\nsample@example.test\n')
        self.assertTrue(any(e['operation'] == 'copy' and e['access_path'] == 'copied' and e['inputs'] for e in events if 'access_path' in e))

    def test_opaque_object_initializer_invalidates_prior_scalar_bindings(self):
        source = '''using System;
class Holder { public Holder(int value) {} }
class Program {
 static int Flow() {
   int number = 1;
   var holder = new Holder(number = 2);
   int copied = number;
   return copied;
 }
 static void Main() { Console.WriteLine(Flow()); }
}
'''
        output, events = self.capture(source)
        self.assertEqual(output, '2\n')
        first = next(e['value_id'] for e in events if e.get('access_path') == 'number' and e['operation'] == 'copy')
        copied = next(e for e in events if e.get('access_path') == 'copied')
        by_id = {e['value_id']: e for e in events}
        pending, ancestors = list(copied['inputs']), set()
        while pending:
            value = pending.pop()
            if value not in ancestors:
                ancestors.add(value); pending.extend(by_id[value]['inputs'])
        self.assertNotIn(first, ancestors, 'Opaque constructor assignment reused the pre-call scalar binding')

    def test_ref_struct_and_anonymous_values_keep_original_csharp_types(self):
        source = '''using System;
class Program {
 static int Flow() {
   Span<int> values = stackalloc int[2]; values[0] = 7;
   var anonymous = new { Value = values[0] };
   return anonymous.Value;
 }
 static void Main() { Console.WriteLine(Flow()); }
}
'''
        output, events = self.capture(source)
        self.assertEqual(output, '7\n')
        self.assertTrue(any(e['operation'] == 'gap' for e in events))

    def test_overlay_cannot_enter_original_project_through_a_symlinked_parent(self):
        with tempfile.TemporaryDirectory(prefix='cbm-csharp-boundary-') as directory:
            root = Path(directory)
            project = root / 'project'; project.mkdir()
            (project / 'App.csproj').write_text('<Project Sdk="Microsoft.NET.Sdk"/>')
            (project / 'Program.cs').write_text('class Program { static void Main() {} }')
            (root / 'alias').symlink_to(project, target_is_directory=True)
            result = subprocess.run([DOTNET, str(self.executable), '--root', str(project), '--out', str(root / 'alias' / 'overlay')],
                                    capture_output=True, text=True, env=self.env, timeout=30)
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse((project / 'overlay').exists(), 'Overlay wrote inside the original project through a path alias')

    def test_source_change_after_parsing_cannot_relabel_old_code_with_new_hash(self):
        with tempfile.TemporaryDirectory(prefix='cbm-csharp-snapshot-') as directory:
            root = Path(directory); project = root / 'project'; project.mkdir()
            before = 'class Program { static string Flow() { return "before"; } static void Main() {} }'
            after = before.replace('"before"', '"after"')
            (project / 'Program.cs').write_text(before)
            (project / 'App.csproj').write_text('<Project Sdk="Microsoft.NET.Sdk"/>')
            # Parsing precedes output-directory creation. These copied assets
            # leave a deterministic opportunity to edit before later emission.
            for index in range(80):
                (project / ('Asset%03d.bin' % index)).write_bytes(b'x' * (256 * 1024))
            output = root / 'overlay'; changed = threading.Event()
            def edit_after_parse():
                deadline = time.monotonic() + 30
                while not output.exists() and time.monotonic() < deadline:
                    time.sleep(.0005)
                if output.exists():
                    (project / 'Program.cs').write_text(after); changed.set()
            editor = threading.Thread(target=edit_after_parse, daemon=True); editor.start()
            result = subprocess.run([DOTNET, str(self.executable), '--root', str(project), '--out', str(output)],
                                    capture_output=True, text=True, env=self.env, timeout=40)
            editor.join(timeout=2)
            self.assertTrue(changed.is_set(), 'Fixture did not exercise the post-parse edit')
            if result.returncode == 0:
                instrumented = (output / 'Program.cs').read_text()
                self.assertIn('"before"', instrumented)
                self.assertIn(hashlib.sha256(before.encode()).hexdigest(), instrumented)
                self.assertNotIn(hashlib.sha256(after.encode()).hexdigest(), instrumented)

if __name__ == '__main__': unittest.main()
