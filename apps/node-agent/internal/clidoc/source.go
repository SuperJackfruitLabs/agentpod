package clidoc

import (
	"bytes"
	"fmt"
	"go/ast"
	"go/parser"
	"go/printer"
	"go/token"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// Source is a binary's package, parsed: what its functions declare and dispatch on.
type Source struct {
	fset  *token.FileSet
	funcs map[string]*ast.FuncDecl
	files []*ast.File
}

// SourceFlag is a flag as its declaration states it.
type SourceFlag struct {
	Name           string
	Type           string // string, bool, int, duration, value (flag.Var); "" when hand-parsed
	Default        string // literal value, or the expression's source text
	DefaultLiteral bool
	Usage          string
	Hand           bool   // compared against by hand rather than declared on a FlagSet
	Set            string // the FlagSet's name when it is a literal ("enroll"), else ""
}

// Load parses every non-test Go file in dir.
func Load(dir string) (*Source, error) {
	fset := token.NewFileSet()
	paths, err := filepath.Glob(filepath.Join(dir, "*.go"))
	if err != nil {
		return nil, err
	}
	s := &Source{fset: fset, funcs: map[string]*ast.FuncDecl{}}
	for _, p := range paths {
		if strings.HasSuffix(p, "_test.go") {
			continue
		}
		b, err := os.ReadFile(p)
		if err != nil {
			return nil, err
		}
		if err := s.add(p, b); err != nil {
			return nil, err
		}
	}
	return s, nil
}

// Parse builds a Source from in-memory files (name → contents), for tests.
func Parse(files map[string]string) (*Source, error) {
	s := &Source{fset: token.NewFileSet(), funcs: map[string]*ast.FuncDecl{}}
	for name, body := range files {
		if err := s.add(name, []byte(body)); err != nil {
			return nil, err
		}
	}
	return s, nil
}

func (s *Source) add(name string, b []byte) error {
	f, err := parser.ParseFile(s.fset, name, b, 0)
	if err != nil {
		return err
	}
	s.files = append(s.files, f)
	for _, d := range f.Decls {
		if fd, ok := d.(*ast.FuncDecl); ok && fd.Recv == nil {
			s.funcs[fd.Name.Name] = fd
		}
	}
	return nil
}

func (s *Source) text(n ast.Node) string {
	var b bytes.Buffer
	_ = printer.Fprint(&b, s.fset, n)
	return b.String()
}

// stringLit returns the value of a string literal, or of a + concatenation of them.
func stringLit(e ast.Expr) (string, bool) {
	switch v := e.(type) {
	case *ast.BasicLit:
		if v.Kind != token.STRING {
			return "", false
		}
		u, err := strconv.Unquote(v.Value)
		return u, err == nil
	case *ast.BinaryExpr:
		if v.Op != token.ADD {
			return "", false
		}
		l, ok1 := stringLit(v.X)
		r, ok2 := stringLit(v.Y)
		return l + r, ok1 && ok2
	case *ast.ParenExpr:
		return stringLit(v.X)
	}
	return "", false
}

var flagMethods = map[string]string{
	"String": "string", "Bool": "bool", "Int": "int", "Int64": "int",
	"Uint": "int", "Float64": "float", "Duration": "duration",
}

// isHelpSpelling is the help flag every command answers; it is documented once, not per verb.
func isHelpSpelling(s string) bool { return s == "-h" || s == "--help" || s == "-help" }

// Flags returns every flag the function declares, keyed by name: FlagSet declarations, and the
// literals a hand-written parser compares arguments against.
//
// A handler spelled "fn/set" keeps only the flags declared on the FlagSet named set, for a
// function (main, typically) that parses several commands' flags in different branches.
func (s *Source) Flags(handler string) (map[string]SourceFlag, error) {
	fn, set, scoped := strings.Cut(handler, "/")
	fd, ok := s.funcs[fn]
	if !ok {
		return nil, fmt.Errorf("no function %s in the source", fn)
	}
	sets := s.flagSets(fd)
	out := map[string]SourceFlag{}
	put := func(f SourceFlag) {
		if scoped && f.Set != set {
			return
		}
		if old, ok := out[f.Name]; ok && len(old.Usage) >= len(f.Usage) {
			return // several FlagSets in one function: keep the fuller description
		}
		out[f.Name] = f
	}
	hand := func(lit string) {
		if strings.HasPrefix(lit, "-") && !isHelpSpelling(lit) {
			if name := strings.TrimLeft(lit, "-"); name != "" {
				if _, declared := out[name]; !declared {
					out[name] = SourceFlag{Name: name, Hand: true, DefaultLiteral: true}
				}
			}
		}
	}
	ast.Inspect(fd.Body, func(n ast.Node) bool {
		switch v := n.(type) {
		case *ast.CallExpr:
			sel, ok := v.Fun.(*ast.SelectorExpr)
			if !ok {
				return true
			}
			if typ, isFlag := flagMethods[sel.Sel.Name]; isFlag && len(v.Args) == 3 {
				name, ok := stringLit(v.Args[0])
				if !ok {
					return true
				}
				usage, _ := stringLit(v.Args[2])
				def, lit := s.literal(v.Args[1])
				put(SourceFlag{Name: name, Type: typ, Default: def, DefaultLiteral: lit, Usage: usage, Set: sets.at(sel.X, v.Pos())})
			}
			if sel.Sel.Name == "Var" && len(v.Args) == 3 {
				name, ok := stringLit(v.Args[1])
				if !ok {
					return true
				}
				usage, _ := stringLit(v.Args[2])
				put(SourceFlag{Name: name, Type: "value", DefaultLiteral: true, Usage: usage, Set: sets.at(sel.X, v.Pos())})
			}
		}
		return true
	})
	if scoped {
		return out, nil // a scoped handler names a FlagSet; hand-parsed flags have none
	}
	// Hand-parsed flags second, so a declared flag of the same name wins.
	ast.Inspect(fd.Body, func(n ast.Node) bool {
		switch v := n.(type) {
		case *ast.CaseClause:
			for _, e := range v.List {
				if lit, ok := stringLit(e); ok {
					hand(lit)
				}
			}
		case *ast.BinaryExpr:
			if v.Op == token.EQL || v.Op == token.NEQ {
				for _, e := range []ast.Expr{v.X, v.Y} {
					if lit, ok := stringLit(e); ok {
						hand(lit)
					}
				}
			}
		}
		return true
	})
	return out, nil
}

// setDecl is one `x := flag.NewFlagSet("name", …)`.
type setDecl struct {
	ident string
	name  string
	pos   token.Pos
}

type setDecls []setDecl

// flagSets finds every FlagSet the function creates, in source order.
func (s *Source) flagSets(fd *ast.FuncDecl) setDecls {
	var out setDecls
	ast.Inspect(fd.Body, func(n ast.Node) bool {
		as, ok := n.(*ast.AssignStmt)
		if !ok || len(as.Lhs) != 1 || len(as.Rhs) != 1 {
			return true
		}
		call, ok := as.Rhs[0].(*ast.CallExpr)
		if !ok {
			return true
		}
		sel, ok := call.Fun.(*ast.SelectorExpr)
		if !ok || sel.Sel.Name != "NewFlagSet" || len(call.Args) == 0 {
			return true
		}
		id, ok := as.Lhs[0].(*ast.Ident)
		if !ok {
			return true
		}
		name, _ := stringLit(call.Args[0])
		out = append(out, setDecl{ident: id.Name, name: name, pos: as.Pos()})
		return true
	})
	return out
}

// at names the FlagSet a receiver refers to at pos: the nearest earlier declaration of it.
func (d setDecls) at(recv ast.Expr, pos token.Pos) string {
	id, ok := recv.(*ast.Ident)
	if !ok {
		return ""
	}
	name := ""
	for _, decl := range d {
		if decl.ident == id.Name && decl.pos < pos {
			name = decl.name
		}
	}
	return name
}

func (s *Source) literal(e ast.Expr) (string, bool) {
	if lit, ok := stringLit(e); ok {
		return lit, true
	}
	switch v := e.(type) {
	case *ast.BasicLit:
		return v.Value, true
	case *ast.Ident:
		if v.Name == "true" || v.Name == "false" {
			return v.Name, true
		}
	}
	return s.text(e), false
}

// Cases returns every string the function compares tag against — in a switch on it, or in an
// == / != with it — excluding help spellings and flag-shaped strings.
func (s *Source) Cases(fn, tag string) ([]string, error) {
	fd, ok := s.funcs[fn]
	if !ok {
		return nil, fmt.Errorf("no function %s in the source", fn)
	}
	seen := map[string]bool{}
	var out []string
	add := func(e ast.Expr) {
		lit, ok := stringLit(e)
		if !ok || lit == "" || strings.HasPrefix(lit, "-") || seen[lit] {
			return
		}
		seen[lit] = true
		out = append(out, lit)
	}
	found := false
	ast.Inspect(fd.Body, func(n ast.Node) bool {
		switch v := n.(type) {
		case *ast.SwitchStmt:
			if v.Tag != nil && s.text(v.Tag) == tag {
				found = true
				for _, st := range v.Body.List {
					for _, e := range st.(*ast.CaseClause).List {
						add(e)
					}
				}
			}
		case *ast.BinaryExpr:
			if v.Op == token.EQL || v.Op == token.NEQ {
				if s.text(v.X) == tag {
					found = true
					add(v.Y)
				} else if s.text(v.Y) == tag {
					found = true
					add(v.X)
				}
			}
		}
		return true
	})
	if !found {
		return nil, fmt.Errorf("%s never switches on or compares %s", fn, tag)
	}
	return out, nil
}

// EnvReads returns every literal variable name passed to a Getenv-shaped call in the package.
func (s *Source) EnvReads() []string {
	seen := map[string]bool{}
	for _, f := range s.files {
		ast.Inspect(f, func(n ast.Node) bool {
			call, ok := n.(*ast.CallExpr)
			if !ok || len(call.Args) == 0 {
				return true
			}
			var name string
			switch fn := call.Fun.(type) {
			case *ast.SelectorExpr:
				name = fn.Sel.Name
			case *ast.Ident:
				name = fn.Name
			}
			switch name {
			case "Getenv", "getenv", "LookupEnv", "envOr":
				if lit, ok := stringLit(call.Args[0]); ok {
					seen[lit] = true
				}
			}
			return true
		})
	}
	return sortedKeys(seen)
}

// flagFor finds a flag in the first handler that declares it.
func (s *Source) flagFor(handlers []string, name string) (SourceFlag, bool) {
	for _, h := range handlers {
		fl, err := s.Flags(h)
		if err != nil {
			continue
		}
		if f, ok := fl[name]; ok {
			return f, true
		}
	}
	return SourceFlag{}, false
}
