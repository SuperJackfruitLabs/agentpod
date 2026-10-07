// Package clidoc renders a binary's command reference as a docs-site page, and checks that the
// reference covers what the binary actually dispatches.
//
// The reference is a table in each binary (cmd/agentpod-node/reference.go,
// cmd/agentpod-fleet/reference.go). What the table cannot be trusted to say on its own comes from
// the binary's source instead:
//
//   - which subcommands exist: read from the dispatch switches named in each Command.Dispatch;
//   - each flag's type, default and meaning: read from the flag.FlagSet declaration (or, for a
//     hand-parsed flag, required of the table);
//   - which environment variables are read: every literal passed to a Getenv-shaped call.
//
// Check fails when the two disagree in either direction, and the page is generated rather than
// written, so a verb, a flag or a variable added to the code without a reference entry fails a
// test instead of quietly going undocumented.
package clidoc

import (
	"fmt"
	"regexp"
	"sort"
	"strings"
)

// Binary is one program's whole reference.
type Binary struct {
	Name        string // what a person types: "apn", "fleet"
	Program     string // the installed program: "agentpod-node"
	Title       string // page title
	Description string // page description (front matter)
	Intro       string // markdown, before the command list
	Regenerate  string // the command that rewrites the page, named in its header comment
	HelpCommand string // how a person prints one command's help, with %s for its path
	Env         []Env
	Auth        string // what a command needs when it does not say
	Exit        string // the exit status when a command does not say
	Groups      []string
	Commands    []Command
}

// Env is one environment variable the binary reads.
type Env struct {
	Name, Meaning string
}

// Command is one verb or subverb.
type Command struct {
	Path     string // relative to the binary: "nodes", "skills canary plan"
	Group    string // top-level commands only: the heading group it renders under
	Summary  string // one sentence, markdown
	Synopsis string // usage line(s), rendered verbatim in a code block
	Help     string // the binary's own help text for this command, rendered verbatim
	Detail   string // markdown
	Args     []Arg
	Flags    []Flag
	Auth     string // empty inherits the nearest ancestor's, then Binary.Auth
	Exit     string // empty means Binary.Exit
	Example  string // shell, rendered verbatim
	TopHelp  bool   // listed in the binary's top-level help as well as under its parent

	// Handlers are the functions whose flag declarations belong to this command. A function may
	// serve several commands (one FlagSet parsed for a whole verb family); every flag it declares
	// must then be documented on at least one of them.
	Handlers []string
	// Dispatch names where this command's subcommands are chosen: a function and the expression
	// its switch (or comparison) tests. Every string it is compared against must be a child.
	Dispatch []Dispatch
}

// Arg is a positional argument.
type Arg struct {
	Name, Meaning string
}

// Flag is one flag. Type, default and meaning come from the source when the flag is declared
// through the flag package; set them here only for a hand-parsed flag or to replace a default
// the source computes (an environment lookup, say).
type Flag struct {
	Name       string // without dashes
	Arg        string // value placeholder; empty for a boolean
	Required   bool
	Repeatable bool
	Usage      string // overrides the source's usage string when set
	Default    string // overrides the source's default when set
}

// Dispatch names one switch (or comparison) that chooses a subcommand.
type Dispatch struct {
	Func string // function name
	Tag  string // source text of the expression switched on, e.g. "args[0]"
}

// children returns the commands one word below path, in table order.
func (b Binary) children(path string) []Command {
	var out []Command
	for _, c := range b.Commands {
		if parentPath(c.Path) == path && c.Path != "" {
			out = append(out, c)
		}
	}
	return out
}

func (b Binary) find(path string) (Command, bool) {
	for _, c := range b.Commands {
		if c.Path == path {
			return c, true
		}
	}
	return Command{}, false
}

func parentPath(path string) string {
	if i := strings.LastIndex(path, " "); i >= 0 {
		return path[:i]
	}
	return ""
}

func lastWord(path string) string {
	return path[strings.LastIndex(path, " ")+1:]
}

// auth resolves what a command needs: its own, else its nearest ancestor's, else the binary's.
func (b Binary) auth(c Command) string {
	for p := c.Path; ; p = parentPath(p) {
		if a, ok := b.find(p); ok && a.Auth != "" {
			return a.Auth
		}
		if p == "" {
			return b.Auth
		}
	}
}

// TopLevel returns the top-level commands of group, in table order.
func (b Binary) TopLevel(group string) []Command {
	var out []Command
	for _, c := range b.children("") {
		if c.Group == group {
			out = append(out, c)
		}
	}
	return out
}

// Render produces the page. src supplies flag types, defaults and meanings; Render returns an
// error rather than a page with a hole in it.
func Render(b Binary, src *Source) (string, error) {
	var w strings.Builder
	// Quoted: a double-quoted Go string is a valid YAML scalar, and a bare one with a colon is not.
	fmt.Fprintf(&w, "---\ntitle: %q\ndescription: %q\n---\n\n", b.Title, b.Description)
	fmt.Fprintf(&w, "<!-- Generated from the %s binary's command table and source. Do not edit by hand:\n     %s -->\n\n", b.Program, b.Regenerate)
	w.WriteString(strings.TrimSpace(b.Intro) + "\n\n")

	w.WriteString("## Commands\n\n")
	for _, g := range b.Groups {
		fmt.Fprintf(&w, "**%s**\n\n", g)
		w.WriteString("| Command | What it does |\n|---|---|\n")
		for _, c := range b.TopLevel(g) {
			fmt.Fprintf(&w, "| [`%s %s`](#%s) | %s |\n", b.Name, c.Path, slug(b.Name+" "+c.Path), cell(c.Summary))
		}
		w.WriteString("\n")
	}

	if len(b.Env) > 0 {
		w.WriteString("## Environment\n\n| Variable | Meaning |\n|---|---|\n")
		for _, e := range b.Env {
			fmt.Fprintf(&w, "| `$%s` | %s |\n", e.Name, cell(e.Meaning))
		}
		w.WriteString("\n")
	}
	fmt.Fprintf(&w, "## Exit status\n\n%s\n\n", strings.TrimSpace(b.Exit))
	fmt.Fprintf(&w, "## Credentials\n\n%s\n\n", strings.TrimSpace(b.Auth))

	for _, g := range b.Groups {
		for _, c := range b.TopLevel(g) {
			if err := renderTree(&w, b, src, c, 2); err != nil {
				return "", err
			}
		}
	}
	return strings.TrimRight(w.String(), "\n") + "\n", nil
}

func renderTree(w *strings.Builder, b Binary, src *Source, c Command, depth int) error {
	if err := renderCommand(w, b, src, c, depth); err != nil {
		return err
	}
	next := depth + 1
	if next > 4 {
		next = 4
	}
	for _, k := range b.children(c.Path) {
		if err := renderTree(w, b, src, k, next); err != nil {
			return err
		}
	}
	return nil
}

func renderCommand(w *strings.Builder, b Binary, src *Source, c Command, depth int) error {
	full := b.Name + " " + c.Path
	fmt.Fprintf(w, "%s %s\n\n", strings.Repeat("#", depth), full)
	fmt.Fprintf(w, "%s\n\n", strings.TrimSpace(c.Summary))
	if c.Synopsis != "" {
		fmt.Fprintf(w, "```text\n%s\n```\n\n", strings.Trim(c.Synopsis, "\n"))
	}
	if c.Detail != "" {
		fmt.Fprintf(w, "%s\n\n", strings.TrimSpace(c.Detail))
	}
	if kids := b.children(c.Path); len(kids) > 0 {
		w.WriteString("Subcommands: ")
		for i, k := range kids {
			if i > 0 {
				w.WriteString(", ")
			}
			fmt.Fprintf(w, "[`%s`](#%s)", lastWord(k.Path), slug(b.Name+" "+k.Path))
		}
		w.WriteString(".\n\n")
	}
	if len(c.Args) > 0 {
		w.WriteString("| Argument | Meaning |\n|---|---|\n")
		for _, a := range c.Args {
			fmt.Fprintf(w, "| `%s` | %s |\n", a.Name, cell(a.Meaning))
		}
		w.WriteString("\n")
	}
	if len(c.Flags) > 0 {
		w.WriteString("| Flag | Type | Default | Meaning |\n|---|---|---|---|\n")
		for _, f := range c.Flags {
			r, err := resolveFlag(src, c, f)
			if err != nil {
				return fmt.Errorf("%s: %w", full, err)
			}
			fmt.Fprintf(w, "| `%s` | %s | %s | %s |\n", cell(flagSpelling(f)), r.typ, r.def, r.usage)
		}
		w.WriteString("\n")
	}
	if c.Help != "" {
		fmt.Fprintf(w, "`"+b.HelpCommand+"` prints:\n\n```text\n%s\n```\n\n", c.Path, strings.Trim(c.Help, "\n"))
	}
	fmt.Fprintf(w, "**Needs:** %s\n\n", strings.TrimSpace(b.auth(c)))
	if c.Exit != "" {
		fmt.Fprintf(w, "**Exit status:** %s\n\n", strings.TrimSpace(c.Exit))
	}
	if c.Example != "" {
		fmt.Fprintf(w, "```sh\n%s\n```\n\n", strings.Trim(c.Example, "\n"))
	}
	return nil
}

type resolved struct{ typ, def, usage string }

// resolveFlag merges a documented flag with its declaration in the source.
func resolveFlag(src *Source, c Command, f Flag) (resolved, error) {
	sf, ok := src.flagFor(c.Handlers, f.Name)
	if !ok {
		return resolved{}, fmt.Errorf("documents --%s, which none of %v declares", f.Name, c.Handlers)
	}
	typ := sf.Type
	if sf.Hand {
		typ = "bool"
		if f.Arg != "" {
			typ = "string"
		}
	}
	def := f.Default
	if def == "" {
		if !sf.DefaultLiteral {
			return resolved{}, fmt.Errorf("--%s defaults to %s, which is not a literal; give the reference a Default", f.Name, sf.Default)
		}
		def = sf.Default
		if def == "" && typ == "bool" {
			def = "false"
		}
	}
	if def == "" {
		def = "—"
	} else if f.Default == "" {
		def = "`" + def + "`"
	} else {
		def = cell(def)
	}
	usage := f.Usage
	if usage == "" {
		usage = sf.Usage
	}
	if strings.TrimSpace(usage) == "" {
		return resolved{}, fmt.Errorf("--%s has no usage text in the source; give the reference one", f.Name)
	}
	usage = cell(CodeFlags(sentence(usage)))
	if f.Required {
		usage += " **Required.**"
	}
	if f.Repeatable && !strings.Contains(strings.ToLower(usage), "repeat") {
		usage += " Repeatable."
	}
	if sf.Type == "value" {
		typ = "string"
	}
	return resolved{typ: typ, def: def, usage: usage}, nil
}

func flagSpelling(f Flag) string {
	dash := "--"
	if len(f.Name) == 1 {
		dash = "-"
	}
	s := dash + f.Name
	if f.Arg != "" {
		s += " " + f.Arg
	}
	return s
}

// sentence capitalises the first letter and ends with a full stop, so source usage strings
// (lower-case fragments, the flag package's convention) read as table prose.
func sentence(s string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return s
	}
	s = strings.ToUpper(s[:1]) + s[1:]
	if !strings.HasSuffix(s, ".") {
		s += "."
	}
	return s
}

var bareFlag = regexp.MustCompile("(^|[\\s(\\[,/])(--[a-z][a-z0-9-]*)")

// CodeFlags puts a bare `--flag` in source-derived text into code spans. Markdown's smart
// punctuation would otherwise turn its two hyphens into a dash.
func CodeFlags(s string) string {
	parts := strings.Split(s, "`")
	for i := 0; i < len(parts); i += 2 { // even parts are outside code spans
		parts[i] = bareFlag.ReplaceAllString(parts[i], "$1`$2`")
	}
	return strings.Join(parts, "`")
}

// cell makes text safe inside a table cell.
func cell(s string) string {
	s = strings.ReplaceAll(strings.TrimSpace(s), "\n", " ")
	s = strings.ReplaceAll(s, "|", "\\|")
	return s
}

// slug is the anchor Starlight gives a heading of plain words.
func slug(s string) string {
	return strings.ReplaceAll(strings.ToLower(strings.TrimSpace(s)), " ", "-")
}

// sortedKeys is for stable error messages.
func sortedKeys(m map[string]bool) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}
