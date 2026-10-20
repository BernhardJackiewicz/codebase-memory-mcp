package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

type recordedEvent struct {
	Operation    string   `json:"operation"`
	InvocationID string   `json:"invocation_id"`
	ValueID      string   `json:"value_id"`
	Inputs       []string `json:"inputs"`
	AccessPath   string   `json:"access_path"`
	Preview      any      `json:"preview"`
	Detail       string   `json:"detail"`
	Source       struct {
		FilePath   string `json:"file_path"`
		SourceHash string `json:"source_hash"`
		Symbol     string `json:"symbol"`
		Line       int    `json:"line"`
	} `json:"source"`
}

func runFixture(t *testing.T, source string, previews bool) ([]recordedEvent, string) {
	t.Helper()
	root, output := t.TempDir(), t.TempDir()
	path := filepath.Join(root, "main.go")
	if err := os.WriteFile(path, []byte(source), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "go.mod"), []byte("module fixture\n\ngo 1.20\n"), 0600); err != nil {
		t.Fatal(err)
	}
	run := func(overlay, endpoint string) string {
		args := []string{"run"}
		if overlay != "" {
			args = append(args, "-overlay", overlay)
		}
		args = append(args, ".")
		command := exec.Command("go", args...)
		command.Dir = root
		command.Env = append(os.Environ(), "GOTOOLCHAIN=local", "GOPROXY=off", "CBM_CAPTURE_ENDPOINT="+endpoint,
			"CBM_CAPTURE_TOKEN=fixture-token", "CBM_CAPTURE_VALUES=0", "CBM_CAPTURE_FIELDS=[]")
		if previews {
			command.Env = append(command.Env, "CBM_CAPTURE_VALUES=1", `CBM_CAPTURE_FIELDS=["Email"]`)
		}
		bytes, err := command.CombinedOutput()
		if err != nil {
			t.Fatalf("go run: %v\n%s", err, bytes)
		}
		return string(bytes)
	}
	plain := run("", "")
	overlay, err := Generate(root, output)
	if err != nil {
		t.Fatal(err)
	}
	var mutex sync.Mutex
	var events []recordedEvent
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/cbm/lineage" || r.URL.Query().Get("session") != "fixture" ||
			r.Header.Get("Authorization") != "Bearer fixture-token" {
			t.Error("wrong explicit receiver or token")
		}
		var body struct {
			Version  int                           `json:"schema_version"`
			Producer struct{ ID, Language string } `json:"producer"`
			Events   []recordedEvent               `json:"events"`
		}
		if err := json.NewDecoder(io.LimitReader(r.Body, 2<<20)).Decode(&body); err != nil {
			t.Error(err)
		}
		if body.Version != 1 || body.Producer.Language != "go" || body.Producer.ID == "" {
			t.Error("invalid producer envelope")
		}
		mutex.Lock()
		events = append(events, body.Events...)
		mutex.Unlock()
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"accepted":true}`))
	}))
	defer server.Close()
	instrumented := run(overlay, server.URL+"/v1/cbm/lineage?session=fixture")
	if plain != instrumented {
		t.Fatalf("application output changed: %q != %q", plain, instrumented)
	}
	bytes, err := os.ReadFile(path)
	if err != nil || string(bytes) != source {
		t.Fatal("original source changed")
	}
	sum := sha256.Sum256([]byte(source))
	hash := hex.EncodeToString(sum[:])
	mutex.Lock()
	defer mutex.Unlock()
	if len(events) == 0 {
		t.Fatal("no actual observations")
	}
	for _, event := range events {
		if event.Source.FilePath != "main.go" || event.Source.SourceHash != hash || event.Source.Line < 1 ||
			event.InvocationID == "" || event.ValueID == "" {
			t.Fatalf("invalid source identity: %+v", event)
		}
		if !previews && event.Preview != nil {
			t.Fatal("preview without opt in")
		}
	}
	return append([]recordedEvent(nil), events...), instrumented
}

func reaches(events []recordedEvent, source, target string) bool {
	seen := map[string]bool{source: true}
	for _, event := range events {
		for _, input := range event.Inputs {
			if seen[input] {
				seen[event.ValueID] = true
			}
		}
	}
	return seen[target]
}

func TestOverlayScalarLineageKillsOverwritesAndPreservesOutput(t *testing.T) {
	events, _ := runFixture(t, `package main
import "fmt"
func transform(input string) string {
	output := input + "!"
	output = "fixed"
	return output
}
func main() { fmt.Println(transform("seed")) }
`, false)
	var parameter, returned string
	transforms := 0
	for _, event := range events {
		if event.Source.Symbol != "transform" {
			continue
		}
		if event.Operation == "value" && event.AccessPath == "input" {
			parameter = event.ValueID
		}
		if event.Operation == "return" {
			returned = event.ValueID
		}
		if event.Operation == "transform" {
			transforms++
		}
	}
	if parameter == "" || returned == "" || transforms == 0 {
		t.Fatalf("missing scalar events: %+v", events)
	}
	if reaches(events, parameter, returned) {
		t.Fatal("overwritten input reached return")
	}
}

func TestOverlayScopesCallsAndFieldPreviewAreExplicit(t *testing.T) {
	events, _ := runFixture(t, `package main
import "fmt"
type User struct { Email string }
func field(user User) string { return user.Email }
func shadow(input string) string {
	{ input := "other"; fmt.Print(input) }
	return input
}
func main() { fmt.Println(shadow("outer"), field(User{"mail@example.test"})) }
`, true)
	var outer, returned string
	field, gap := false, false
	for _, event := range events {
		if event.Source.Symbol == "shadow" && event.AccessPath == "input" && event.Operation == "value" && outer == "" {
			outer = event.ValueID
		}
		if event.Source.Symbol == "shadow" && event.Operation == "return" {
			returned = event.ValueID
		}
		if event.Operation == "field" && event.AccessPath == "Email" && event.Preview == "mail@example.test" {
			field = true
		}
		if event.Operation == "gap" && strings.Contains(event.Detail, "context") {
			gap = true
		}
		if event.Preview != nil && event.AccessPath != "Email" {
			t.Fatal("preview escaped allowlist")
		}
	}
	// The opaque fmt.Print call invalidates transport conservatively.
	if outer == "" || returned == "" || reaches(events, outer, returned) || !field || !gap {
		t.Fatalf("missing scope/gap/field evidence: %+v", events)
	}
}

func TestOverlayPreservesNamedReturnsTypedNilAndRecover(t *testing.T) {
	events, output := runFixture(t, `package main
import "fmt"
func named() (value int) { defer func(){ value = 8 }(); return 2 }
func maybe() *int { return nil }
func panicValue() (out string) { defer func(){ out = fmt.Sprint(recover()) }(); panic("kept") }
func main(){ var v any = maybe(); fmt.Println(named(), v == nil, panicValue()) }
`, false)
	if output != "8 false kept\n" {
		t.Fatal(output)
	}
	gap := false
	for _, event := range events {
		if event.Operation == "gap" {
			gap = true
		}
	}
	if !gap {
		t.Fatal("unsupported shapes need explicit gaps")
	}
}

func TestOverlayRejectsOutputInsideSourceRoot(t *testing.T) {
	root := t.TempDir()
	_, err := Generate(root, filepath.Join(root, "generated"))
	if err == nil {
		t.Fatal("overlay output must not mutate project source")
	}
}

func TestOverlayPreservesContextualConstantsAndActualShadowBindings(t *testing.T) {
	events, output := runFixture(t, `package main
import "fmt"
type Small uint8
func narrow() Small { return 1 + 2 }
func scope(input string) string {
	{ input := "inner"; if input == "" { return input } }
	return input
}

func main(){ fmt.Println(narrow(), scope("outer")) }
`, false)
	if output != "3 outer\n" {
		t.Fatal(output)
	}
	var parameter, returned string
	for _, event := range events {
		if event.Source.Symbol != "scope" {
			continue
		}
		if event.Operation == "value" && event.AccessPath == "input" {
			parameter = event.ValueID
		}
		if event.Operation == "return" {
			returned = event.ValueID
		}
	}
	if parameter == "" || returned == "" || !reaches(events, parameter, returned) {
		t.Fatal("lexical shadowing lost the outer binding")
	}
}

func TestOverlayUninstrumentedLoopPostInvalidatesFinalStorage(t *testing.T) {
	events, output := runFixture(t, `package main
import "fmt"
func flow(input int) int {
	x := input
	for ; x < 10; x++ { x = x + 1 }
	return x
}
func main(){ fmt.Println(flow(8)) }
`, false)
	if output != "10\n" {
		t.Fatal(output)
	}
	var lastRead *recordedEvent
	for i := range events {
		if events[i].Source.Symbol == "flow" && events[i].Operation == "copy" && events[i].AccessPath == "x" {
			lastRead = &events[i]
		}
	}
	if lastRead == nil || len(lastRead.Inputs) != 0 {
		t.Fatalf("loop post retained stale storage: %+v", lastRead)
	}
}

func TestOverlayConcurrentInvocationsNeverInventCallerContext(t *testing.T) {
	events, output := runFixture(t, `package main
import "fmt"
func flow(input int) int { return input + 1 }
func main() {
 results := make(chan int, 2)
 go func(){ results <- flow(1) }()
 go func(){ results <- flow(2) }()
 fmt.Println(<-results + <-results)
}
`, false)
	if output != "5\n" {
		t.Fatal(output)
	}
	owners := map[string]string{}
	invocations := map[string]bool{}
	for _, event := range events {
		owners[event.ValueID] = event.InvocationID
		if event.Source.Symbol == "flow" {
			invocations[event.InvocationID] = true
		}
	}
	if len(invocations) != 2 {
		t.Fatalf("wrong invocation count: %v", invocations)
	}
	for _, event := range events {
		for _, input := range event.Inputs {
			if owners[input] != event.InvocationID {
				t.Fatal("invented goroutine/caller correlation")
			}
		}
	}
}
