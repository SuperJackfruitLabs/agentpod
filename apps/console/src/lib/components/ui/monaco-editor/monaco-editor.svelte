<script lang="ts">
  import { onMount } from "svelte";
  import { appearance } from "$lib/appearance.svelte";

  interface Props {
    code: string;
    language?: string;
    readonly?: boolean;
    class?: string;
    onchange?: (value: string) => void;
    onsave?: () => void;
  }

  let {
    code,
    language = "plaintext",
    readonly = false,
    class: className = "",
    onchange,
    onsave,
  }: Props = $props();

  let containerRef: HTMLDivElement | undefined = $state();
  let editor: import("monaco-editor").editor.IStandaloneCodeEditor | undefined = $state();
  let monaco: typeof import("monaco-editor") | undefined = $state();

  // Map file extensions to Monaco language IDs
  function getMonacoLanguage(lang: string): string {
    const languageMap: Record<string, string> = {
      // JavaScript/TypeScript
      js: "javascript",
      jsx: "javascript",
      ts: "typescript",
      tsx: "typescript",
      mjs: "javascript",
      cjs: "javascript",
      mts: "typescript",
      cts: "typescript",
      
      // Web
      html: "html",
      htm: "html",
      css: "css",
      scss: "scss",
      sass: "scss",
      less: "less",
      
      // Data formats
      json: "json",
      jsonc: "json",
      yaml: "yaml",
      yml: "yaml",
      xml: "xml",
      toml: "ini",
      
      // Markdown
      md: "markdown",
      mdx: "markdown",
      
      // Shell
      sh: "shell",
      bash: "shell",
      zsh: "shell",
      fish: "shell",
      ps1: "powershell",
      
      // Programming languages
      py: "python",
      python: "python",
      rb: "ruby",
      ruby: "ruby",
      rs: "rust",
      rust: "rust",
      go: "go",
      java: "java",
      kt: "kotlin",
      kotlin: "kotlin",
      scala: "scala",
      swift: "swift",
      c: "c",
      cpp: "cpp",
      cc: "cpp",
      cxx: "cpp",
      h: "c",
      hpp: "cpp",
      cs: "csharp",
      php: "php",
      
      // Config
      dockerfile: "dockerfile",
      makefile: "makefile",
      cmake: "cmake",
      
      // Others
      sql: "sql",
      graphql: "graphql",
      gql: "graphql",
      svelte: "html", // Monaco doesn't have native Svelte support
      vue: "html",
      
      // Plain text
      txt: "plaintext",
      text: "plaintext",
      log: "plaintext",
    };

    const normalized = lang.toLowerCase();
    return languageMap[normalized] || normalized;
  }

  // Get Monaco theme based on app theme
  function getMonacoTheme(): string {
    return appearance.theme === "dark" ? "vs-dark" : "vs";
  }

  async function initMonaco() {
    const monacoModule = await import("monaco-editor");
    monaco = monacoModule;

    (self as unknown as Record<string, unknown>).MonacoEnvironment = {
      getWorker: function () {
        const workerBlob = new Blob(
          ["self.onmessage = function() {}"],
          { type: "application/javascript" }
        );
        return new Worker(URL.createObjectURL(workerBlob));
      }
    };

    if (!containerRef) return;

    editor = monaco.editor.create(containerRef, {
      value: code,
      language: getMonacoLanguage(language),
      theme: getMonacoTheme(),
      readOnly: readonly,
      minimap: { enabled: false },
      fontSize: 14,
      fontFamily: "var(--font-mono), 'JetBrains Mono', 'Fira Code', Consolas, monospace",
      lineNumbers: "on",
      scrollBeyondLastLine: false,
      wordWrap: "on",
      automaticLayout: true,
      tabSize: 2,
      insertSpaces: true,
      renderWhitespace: "selection",
      bracketPairColorization: { enabled: true },
      guides: {
        bracketPairs: true,
        indentation: true,
      },
      padding: { top: 12, bottom: 12 },
      scrollbar: {
        verticalScrollbarSize: 10,
        horizontalScrollbarSize: 10,
      },
      overviewRulerBorder: false,
      hideCursorInOverviewRuler: true,
      renderLineHighlight: "line",
      cursorBlinking: "smooth",
      cursorSmoothCaretAnimation: "on",
      smoothScrolling: true,
    });

    editor.onDidChangeModelContent(() => {
      const value = editor?.getValue() ?? "";
      onchange?.(value);
    });

    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      onsave?.();
    });
  }

  onMount(() => {
    initMonaco();
    
    return () => {
      editor?.dispose();
      editor = undefined;
    };
  });

  // Update editor content when code prop changes externally
  $effect(() => {
    if (editor && code !== editor.getValue()) {
      editor.setValue(code);
    }
  });

  // Update language when it changes
  $effect(() => {
    if (editor && monaco) {
      const model = editor.getModel();
      if (model) {
        monaco.editor.setModelLanguage(model, getMonacoLanguage(language));
      }
    }
  });

  // Update theme when app theme changes
  $effect(() => {
    if (editor && monaco) {
      const theme = getMonacoTheme();
      monaco.editor.setTheme(theme);
    }
  });

  // Update readonly state
  $effect(() => {
    if (editor) {
      editor.updateOptions({ readOnly: readonly });
    }
  });

  // Focus the editor
  export function focus() {
    editor?.focus();
  }

  // Get current value
  export function getValue(): string {
    return editor?.getValue() ?? code;
  }
</script>

<div
  bind:this={containerRef}
  class="monaco-editor-container {className}"
></div>

<style>
  .monaco-editor-container {
    width: 100%;
    height: 100%;
    min-height: 200px;
  }

  /* Ensure Monaco fills its container */
  .monaco-editor-container :global(.monaco-editor) {
    width: 100% !important;
    height: 100% !important;
  }

  /* Match scrollbar styling with app theme */
  .monaco-editor-container :global(.monaco-scrollable-element > .scrollbar > .slider) {
    background: var(--muted-foreground);
    opacity: 0.3;
    border-radius: 4px;
  }

  .monaco-editor-container :global(.monaco-scrollable-element > .scrollbar > .slider:hover) {
    opacity: 0.5;
  }
</style>
