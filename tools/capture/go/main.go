// cbm-capture-go creates an explicit, temporary Go build overlay.
package main

import (
	"flag"
	"fmt"
	"os"
)

func main() {
	root := flag.String("root", "", "project source root")
	out := flag.String("out", "", "empty temporary output directory outside the project")
	flag.Parse()
	overlay, err := Generate(*root, *out)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	fmt.Println(overlay)
}
