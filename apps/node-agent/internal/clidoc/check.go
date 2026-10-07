package clidoc

import (
	"fmt"
	"os"
	"strings"
)

// Check compares a reference with the source it documents and returns every disagreement:
//
//   - a subcommand a dispatch switch chooses with no reference entry, or an entry no switch
//     chooses;
//   - a command with no summary or example, or a top-level command in no listed group;
//   - a documented flag no handler declares, or a declared flag no command documents;
//   - an environment variable the package reads that the reference does not list.
func Check(b Binary, src *Source) []error {
	var errs []error
	fail := func(format string, a ...any) { errs = append(errs, fmt.Errorf(format, a...)) }

	paths := map[string]bool{}
	groups := map[string]bool{}
	for _, g := range b.Groups {
		groups[g] = true
	}
	for _, c := range b.Commands {
		full := strings.TrimSpace(b.Name + " " + c.Path)
		if paths[c.Path] {
			fail("%s: listed twice", full)
		}
		paths[c.Path] = true
		if c.Path == "" {
			continue // the binary itself: carries Dispatch only
		}
		if parent := parentPath(c.Path); parent != "" {
			if _, ok := b.find(parent); !ok {
				fail("%s: its parent %q has no entry", full, b.Name+" "+parent)
			}
		} else if !groups[c.Group] {
			fail("%s: group %q is not one of %v", full, c.Group, b.Groups)
		}
		if strings.TrimSpace(c.Summary) == "" {
			fail("%s: no summary", full)
		}
		if c.Help != "" && b.HelpCommand == "" {
			fail("%s: has Help but the binary names no HelpCommand", full)
		}
		if strings.TrimSpace(c.Example) == "" {
			fail("%s: no example", full)
		}
		for _, f := range c.Flags {
			if _, err := resolveFlag(src, c, f); err != nil {
				fail("%s: %v", full, err)
			}
		}
	}

	// Dispatch, both directions.
	for _, c := range b.Commands {
		if len(c.Dispatch) == 0 {
			continue
		}
		dispatched := map[string]bool{}
		for _, d := range c.Dispatch {
			cases, err := src.Cases(d.Func, d.Tag)
			if err != nil {
				fail("%s: %v", strings.TrimSpace(b.Name+" "+c.Path), err)
				continue
			}
			for _, v := range cases {
				dispatched[v] = true
			}
		}
		documented := map[string]bool{}
		for _, k := range b.children(c.Path) {
			documented[lastWord(k.Path)] = true
		}
		for _, v := range sortedKeys(dispatched) {
			if !documented[v] {
				fail("%s is dispatched but has no reference entry", join(b.Name, c.Path, v))
			}
		}
		for _, v := range sortedKeys(documented) {
			if !dispatched[v] {
				fail("%s has a reference entry but nothing dispatches it", join(b.Name, c.Path, v))
			}
		}
	}
	// A command with children must say where they are dispatched, or the check above has
	// nothing to compare them with.
	for _, c := range b.Commands {
		if len(b.children(c.Path)) > 0 && len(c.Dispatch) == 0 {
			fail("%s has subcommands but no Dispatch to check them against", strings.TrimSpace(b.Name+" "+c.Path))
		}
	}

	// Declared flags, each documented somewhere. Grouped by function, whatever FlagSet scope a
	// handler names, so a FlagSet no scoped handler mentions is still checked.
	handlers := map[string][]Command{}
	for _, c := range b.Commands {
		for _, h := range c.Handlers {
			fn, _, _ := strings.Cut(h, "/")
			handlers[fn] = append(handlers[fn], c)
		}
	}
	for _, h := range sortedCommandKeys(handlers) {
		cmds := handlers[h]
		declared, err := src.Flags(h)
		if err != nil {
			fail("%v", err)
			continue
		}
		documented := map[string]bool{}
		for _, c := range cmds {
			for _, f := range c.Flags {
				documented[f.Name] = true
			}
		}
		for _, name := range sortedFlagNames(declared) {
			if !documented[name] {
				var where []string
				for _, c := range cmds {
					where = append(where, join(b.Name, c.Path))
				}
				fail("--%s is declared in %s but documented on none of %v", name, h, where)
			}
		}
	}

	// Environment.
	listed := map[string]bool{}
	for _, e := range b.Env {
		listed[e.Name] = true
	}
	for _, v := range src.EnvReads() {
		if !listed[v] {
			fail("$%s is read by %s but not listed in its environment", v, b.Name)
		}
	}
	return errs
}

func sortedFlagNames(m map[string]SourceFlag) []string {
	keys := map[string]bool{}
	for k := range m {
		keys[k] = true
	}
	return sortedKeys(keys)
}

// Sync renders b and compares it with the committed page at path. With update it writes the
// page instead. Either way a reference that fails Check is an error: a page is never written
// over a hole.
func Sync(b Binary, src *Source, path string, update bool) error {
	if errs := Check(b, src); len(errs) > 0 {
		var msg []string
		for _, e := range errs {
			msg = append(msg, "  "+e.Error())
		}
		return fmt.Errorf("the %s reference disagrees with its source:\n%s", b.Name, strings.Join(msg, "\n"))
	}
	page, err := Render(b, src)
	if err != nil {
		return err
	}
	if update {
		return os.WriteFile(path, []byte(page), 0o644)
	}
	committed, err := os.ReadFile(path)
	if err != nil {
		return fmt.Errorf("read %s: %w (regenerate with: %s)", path, err, b.Regenerate)
	}
	if string(committed) != page {
		return fmt.Errorf("%s is out of date with the %s command table; regenerate it with:\n  %s", path, b.Name, b.Regenerate)
	}
	return nil
}

// join spells a command path, skipping empty parts.
func join(parts ...string) string {
	var out []string
	for _, p := range parts {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return strings.Join(out, " ")
}

func sortedCommandKeys(m map[string][]Command) []string {
	keys := map[string]bool{}
	for k := range m {
		keys[k] = true
	}
	return sortedKeys(keys)
}
