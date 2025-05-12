# CodeEcho

CodeEcho is a VS Code extension that provides intelligent code suggestions powered by Ollama's Qwen2.5-Coder local AI model.

## Features

- Instant code suggestions as you type
- Works completely offline using Ollama's local AI model
- Supports Python, JavaScript, TypeScript, React, HTML, CSS
- Smart context awareness - uses surrounding code to provide relevant suggestions
- Automatic installation of required model

## Requirements

This extension requires [Ollama](https://ollama.com/download) to be installed on your system.

When the extension is first activated, it will:
1. Check if Ollama is installed
2. Download the Qwen2.5-Coder model if not already present
3. Start the Ollama server if it's not running

## Installation

1. Install [Ollama](https://ollama.com/download) for your operating system
2. Install this VS Code extension
3. The extension will automatically download the required model on first use

## Extension Settings

This extension contributes the following settings:

* `codeecho.endpoint`: URL of the Ollama API for code completion (default: "http://localhost:11434/api/chat")
* `codeecho.contextRadius`: Number of lines above/below cursor to send as context (default: 10)
* `codeecho.debounceMs`: Delay (ms) after typing before requesting completion (default: 100)

## Commands

* `CodeEcho: Trigger Suggestion` - Manually trigger a code suggestion (Ctrl+Space Ctrl+E or Cmd+Space Cmd+E on Mac)
* `CodeEcho: Clear Suggestion Cache` - Clear the cache of recent suggestions (Ctrl+Shift+Space Ctrl+Shift+E or Cmd+Shift+Space Cmd+Shift+E on Mac)

## How it Works

CodeEcho communicates with a local Ollama server running the Qwen2.5-Coder model. When you're typing code, it sends the surrounding context to the model and displays relevant completions directly in your editor.

All processing happens on your local machine - no code is sent to external servers.

## Troubleshooting

If you encounter issues:

1. Ensure Ollama is installed and running (`ollama serve` in terminal)
2. Verify the Qwen2.5-Coder model is downloaded (`ollama list` should show it)
3. If needed, download the model manually: `ollama pull qwen2.5-coder`
4. Restart VS Code

## Release Notes

### 0.0.1

- Initial release of CodeEcho
- Support for Python, JavaScript, TypeScript, React, HTML, CSS
- Automatic model installation and server management

**Enjoy coding with AI assistance!**
