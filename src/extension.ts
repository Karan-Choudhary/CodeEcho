import * as vscode from 'vscode';
import { queryLocalModel } from './query';
import * as cp from 'child_process';
import * as path from 'path';
import * as os from 'os';

/** Async debounce helper */
function debounce<T extends (...args: any[]) => Promise<any>>(fn: T, ms: number): T {
	let timer: NodeJS.Timeout | null = null;
	return function(this: any, ...args: any[]) {
		if (timer) {
			clearTimeout(timer);
		}
		return new Promise(resolve => {
			timer = setTimeout(() => {
				const result = fn.apply(this, args);
				resolve(result);
			}, ms);
		});
	} as T;
}

function getSurroundingLines(doc: vscode.TextDocument, pos: vscode.Position, radius: number): string {
	const start = Math.max(0, pos.line - radius);
	const end = Math.min(doc.lineCount - 1, pos.line + radius);
	return Array.from({ length: end - start + 1 }, (_, i) => doc.lineAt(start + i).text).join('\n');
}

async function checkOllamaInstalled(): Promise<boolean> {
	return new Promise<boolean>((resolve) => {
		cp.exec('ollama --version', (error) => {
			if (error) {
				resolve(false);
			} else {
				resolve(true);
			}
		});
	});
}

/** Check if model is already installed */
async function checkModelInstalled(model: string): Promise<boolean> {
	return new Promise<boolean>((resolve) => {
		cp.exec('ollama list', (error, stdout) => {
			if (error) {
				resolve(false);
			} else {
				resolve(stdout.toLowerCase().includes(model.toLowerCase()));
			}
		});
	});
}

/** Pull Ollama model */
async function pullOllamaModel(model: string): Promise<boolean> {
	return new Promise<boolean>((resolve) => {
		const pullProcess = cp.spawn('ollama', ['pull', model]);
		
		vscode.window.withProgress({
			location: vscode.ProgressLocation.Notification,
			title: `Downloading ${model} model...`,
			cancellable: true
		}, async (progress, token) => {
			return new Promise<void>((progressResolve) => {
				let lastProgress = '';
				
				token.onCancellationRequested(() => {
					pullProcess.kill();
					vscode.window.showWarningMessage(`CodeEcho: ${model} download canceled. The extension may not work properly.`);
					resolve(false);
					progressResolve();
				});
				
				pullProcess.stdout.on('data', (data) => {
					const output = data.toString();
					console.log(`stdout: ${output}`);
					
					// Try to extract progress information
					const progressMatch = output.match(/(\d+)%/);
					if (progressMatch && progressMatch[1] !== lastProgress) {
						lastProgress = progressMatch[1];
						progress.report({
							message: `${lastProgress}% - This may take several minutes for the first download`,
							increment: parseInt(lastProgress) - parseInt(lastProgress || '0')
						});
					}
				});
				
				pullProcess.stderr.on('data', (data) => {
					console.log(`stderr: ${data}`);
				});
				
				pullProcess.on('close', (code) => {
					if (code === 0) {
						resolve(true);
					} else {
						resolve(false);
					}
					progressResolve();
				});
			});
		});
	});
}

/** Start Ollama server */
function startOllamaServer(): Promise<boolean> {
	return new Promise<boolean>((resolve) => {
		try {
			const netstatCmd = os.platform() === 'win32' ? 'netstat -ano | findstr 11434' : 'lsof -i :11434';
			
			try {
				cp.execSync(netstatCmd, { stdio: 'pipe' });
				console.log('Ollama server already running');
				resolve(true); // Server already running
				return;
			} catch (error) {
				console.log('Starting Ollama server...');
				
				vscode.window.withProgress({
					location: vscode.ProgressLocation.Notification,
					title: 'Starting Ollama server...',
					cancellable: false
				}, async (progress) => {
					return new Promise<void>((progressResolve) => {
						const ollamaProcess = cp.spawn('ollama', ['serve'], { 
							detached: true,
							stdio: 'pipe'
						});
						
						ollamaProcess.stderr.on('data', (data) => {
							console.error(`Ollama server error: ${data}`);
						});
						
						ollamaProcess.stdout.on('data', (data) => {
							console.log(`Ollama server: ${data}`);
							if (data.toString().includes('listening')) {
								progress.report({ message: 'Server started successfully' });
								setTimeout(() => {
									resolve(true);
									progressResolve();
								}, 1000);
							}
						});
						
						// Set a timeout in case the server doesn't start
						const timeout = setTimeout(() => {
							console.log('Ollama server start timeout - assuming success');
							resolve(true);
							progressResolve();
						}, 10000);  // 10 second timeout
						
						ollamaProcess.on('error', (err) => {
							console.error('Failed to start Ollama server:', err);
							clearTimeout(timeout);
							resolve(false);
							progressResolve();
						});
						
						// Unref the process so it can run in the background
						ollamaProcess.unref();
					});
				});
			}
		} catch (error) {
			console.error('Error starting Ollama server:', error);
			resolve(false);
		}
	});
}

class CodeEchoProvider implements vscode.InlineCompletionItemProvider {
	private provideDebounced: (
		document: vscode.TextDocument,
		position: vscode.Position,
		context: vscode.InlineCompletionContext,
		token: vscode.CancellationToken
	) => Promise<vscode.InlineCompletionItem[]>;

	private lastRequest: { position: vscode.Position, text: string } | null = null;
	private isProcessing = false;
	private suggestionCache: Map<string, { items: vscode.InlineCompletionItem[], timestamp: number }> = new Map();
	private lastTriggerTime: number = 0;
	private readonly CACHE_TTL = 2000; // Cache suggestions for 2 seconds
	private readonly MIN_TRIGGER_INTERVAL = 300; // Minimum time between triggers (0.3 seconds)
	private readonly MAX_CACHE_SIZE = 50; // Maximum number of cached suggestions
	private retryCount: number = 0;
	private readonly MAX_RETRIES = 3;

	private readonly patternCategories = {
		// Basic patterns that should always trigger
		basic: [
			{ pattern: /.*$/, description: 'Any text' },
			{ pattern: /^\s*$/, description: 'Empty line or whitespace' }
		],

		// Python specific patterns (for special handling)
		python: [
			{ pattern: /if\s+__name__\s*==\s*["']$/, description: 'After if __name__ == "' },
			{ pattern: /if\s+__name__\s*==\s*$/, description: 'After if __name__ ==' },
			{ pattern: /if\s+__name__\s*$/, description: 'After if __name__' }
		],

		// Common code patterns (for special handling)
		common: [
			{ pattern: /:$/, description: 'After colon' },
			{ pattern: /if\s*$/, description: 'After if' },
			{ pattern: /def\s+\w+\s*\($/, description: 'After function definition' },
			{ pattern: /class\s+\w+\s*\($/, description: 'After class definition' }
		]
	};

	constructor() {
		const cfg = vscode.workspace.getConfiguration('codeecho');
		
		const defaultDebounce = 30;
		const ms = cfg.get<number>('debounceMs') || defaultDebounce;
		
		this.provideDebounced = debounce(this.provideInternal.bind(this), ms);
		
		// Clear any existing cache on startup
		this.suggestionCache.clear();
	}

	private shouldTrigger(prefix: string): boolean {
		const isComment = this.isInComment(prefix);
		if (isComment) {
			return false;
		}
		return true;
	}
	
	// Helper to check if we're in a comment
	private isInComment(prefix: string): boolean {
		// Check for Python single-line comments
		if (prefix.trimLeft().startsWith('#')) {
			return true;
		}
		
		// Check for JavaScript/TypeScript single-line comments
		if (prefix.trimLeft().startsWith('//')) {
			return true;
		}
		
		// Check for multi-line comments (simple version)
		const commentStart = prefix.lastIndexOf('/*');
		const commentEnd = prefix.lastIndexOf('*/');
		if (commentStart > -1 && (commentEnd === -1 || commentEnd < commentStart)) {
			return true;
		}
		
		// Check for Python docstrings
		const tripleQuotesCount = (prefix.match(/"""/g) || []).length;
		if (tripleQuotesCount % 2 !== 0) {
			return true;
		}
		
		// Check for Python single-quoted docstrings
		const tripleSingleQuotesCount = (prefix.match(/'''/g) || []).length;
		if (tripleSingleQuotesCount % 2 !== 0) {
			return true;
		}
		
		return false;
	}

	private getPatternDescription(prefix: string): string | undefined {
		for (const category of Object.values(this.patternCategories)) {
			for (const { pattern, description } of category) {
				if (pattern.test(prefix)) {
					return description;
				}
			}
		}
		return undefined;
	}

	private getCacheKey(document: vscode.TextDocument, position: vscode.Position): string {
		// Create a cache key based on the current context
		const line = document.lineAt(position.line).text;
		const prefix = line.slice(0, position.character);
		return `${document.uri.toString()}:${position.line}:${prefix}`;
	}

	provideInlineCompletionItems(
		document: vscode.TextDocument,
		position: vscode.Position,
		context: vscode.InlineCompletionContext,
		token: vscode.CancellationToken
	): Thenable<vscode.InlineCompletionItem[]> {
		const currentText = document.getText(new vscode.Range(
			position.line,
			0,
			position.line,
			position.character
		));
		
		if (this.isInComment(currentText)) {
			return Promise.resolve([]);
		}

		const now = Date.now();
		this.lastTriggerTime = now;
		this.lastRequest = { position, text: currentText };
		
		const cacheKey = this.getCacheKey(document, position);
		const cached = this.suggestionCache.get(cacheKey);
		if (cached && now - cached.timestamp < this.CACHE_TTL) {
			const hasStaticSuggestion = cached.items.some(item => 
				item.insertText === "# Static suggestion for testing"
			);
			
			if (!hasStaticSuggestion) {
				return Promise.resolve(cached.items);
			} else {
				this.suggestionCache.delete(cacheKey);
			}
		}

		return this.provideDebounced(document, position, context, token);
	}

	private async provideInternal(
		document: vscode.TextDocument,
		position: vscode.Position,
		context: vscode.InlineCompletionContext,
		token: vscode.CancellationToken
	): Promise<vscode.InlineCompletionItem[]> {
		if (token.isCancellationRequested) {
			return [];
		}
		
		if (this.isProcessing) {
			return [];
		}

		try {
			this.isProcessing = true;
			const cfg = vscode.workspace.getConfiguration('codeecho');
			const radius = cfg.get<number>('contextRadius')!;
			
			const currentLine = document.lineAt(position.line);
			const prefix = currentLine.text.slice(0, position.character);
			
			// Log which pattern triggered the suggestion
			const patternDescription = this.getPatternDescription(prefix);
			if (patternDescription) {
			}
			
			// Special handling for Python's if __name__ == "__main__"
			if (prefix.includes('if __name__') && !prefix.includes('__main__')) {
				const items = [new vscode.InlineCompletionItem('__main__":')];
				items[0].range = new vscode.Range(position, position);
				return items;
			}

			// Special handling for if statements
			if (prefix.trim().startsWith('if ') || prefix.trim() === 'if') {
				const items = [new vscode.InlineCompletionItem(' condition:')];
				items[0].range = new vscode.Range(position, position);
				return items;
			}

			// Special handling for colons
			if (prefix.endsWith(':')) {
				const items = [new vscode.InlineCompletionItem('\n    pass')];
				items[0].range = new vscode.Range(position, position);
				return items;
			}

			// Special handling for empty lines
			if (prefix.trim() === '') {
				const prevLine = position.line > 0 ? document.lineAt(position.line - 1).text : '';
				const prevLineTrimmed = prevLine.trim();

				if (prevLineTrimmed.endsWith(':')) {
					const items = [new vscode.InlineCompletionItem('    pass')];
					items[0].range = new vscode.Range(position, position);
					return items;
				} else if (prevLineTrimmed.startsWith('def ')) {
					const items = [new vscode.InlineCompletionItem('    pass')];
					items[0].range = new vscode.Range(position, position);
					return items;
				} else if (prevLineTrimmed.startsWith('class ')) {
					const items = [new vscode.InlineCompletionItem('    pass')];
					items[0].range = new vscode.Range(position, position);
					return items;
				}
			}
			
			const snippet = getSurroundingLines(document, position, radius);
			
			const payload = `EXISTING CODE (DO NOT REPEAT THIS):\n${prefix}\n\nCONTEXT:\n${snippet}\n\nINSTRUCTIONS: Complete the code starting from where the cursor is. DO NOT repeat any existing code. Only provide the completion part.`;
			
			const suggestions = await queryLocalModel(payload);
			
			if (suggestions.length === 0) {
				// If no suggestions and we haven't exceeded retry limit, try again
				if (this.retryCount < this.MAX_RETRIES) {
					this.retryCount++;
					return this.provideInternal(document, position, context, token);
				}
				return [];
			}

			// Reset retry count on success
			this.retryCount = 0;

			// Create inline completion items
			const items = suggestions.map(text => {
				const item = new vscode.InlineCompletionItem(text);
				item.range = new vscode.Range(position, position);
				return item;
			});

			const cacheKey = this.getCacheKey(document, position);
			this.suggestionCache.set(cacheKey, {
				items,
				timestamp: Date.now()
			});

			this.cleanupCache();

			this.checkIfSuggestionsAreVisible(items);

			return items;
		} catch (error) {
			console.error('CodeEcho Error:', error);
			if (this.retryCount < this.MAX_RETRIES) {
				this.retryCount++;
				return this.provideInternal(document, position, context, token);
			}
			vscode.window.showErrorMessage(`CodeEcho: Error generating suggestions: ${error}`);
			return [];
		} finally {
			this.isProcessing = false;
		}
	}

	private checkIfSuggestionsAreVisible(items: vscode.InlineCompletionItem[]) {
		if (items.length > 0) {
			setTimeout(() => {
			}, 500);
		}
	}

	// Method to clear the entire cache
	clearCache() {
		this.suggestionCache.clear();
		vscode.window.showInformationMessage('CodeEcho: Suggestion cache cleared');
	}

	private cleanupCache() {
		const now = Date.now();
		for (const [key, value] of this.suggestionCache.entries()) {
			if (now - value.timestamp > this.CACHE_TTL) {
				this.suggestionCache.delete(key);
			}
		}
		if (this.suggestionCache.size > this.MAX_CACHE_SIZE) {
			const entries = Array.from(this.suggestionCache.entries())
				.sort((a, b) => a[1].timestamp - b[1].timestamp);
			const toRemove = entries.slice(0, entries.length - this.MAX_CACHE_SIZE);
			toRemove.forEach(([key]) => this.suggestionCache.delete(key));
		}
	}
}

export async function activate(ctx: vscode.ExtensionContext) {
	// Enable inline suggestions
	vscode.workspace.getConfiguration('editor').update('inlineSuggest.enabled', true, true);
	vscode.workspace.getConfiguration('editor').update('inlineSuggest.showToolbar', 'always', true);
	
	// Setup model and server
	try {
		// Check if Ollama is installed
		const ollamaInstalled = await checkOllamaInstalled();
		if (!ollamaInstalled) {
			const action = await vscode.window.showErrorMessage(
				'Ollama is not installed. CodeEcho requires Ollama to provide AI code suggestions.',
				'Install Instructions',
				'Cancel'
			);
			if (action === 'Install Instructions') {
				vscode.env.openExternal(vscode.Uri.parse('https://ollama.com/download'));
				vscode.window.showInformationMessage('Please restart VS Code after installing Ollama');
			}
			return;
		}

		const serverStarted = await startOllamaServer();
		if (!serverStarted) {
			const action = await vscode.window.showErrorMessage(
				'Failed to start Ollama server. Please start it manually.',
				'How to Start',
				'Continue Anyway'
			);
			if (action === 'How to Start') {
				vscode.window.showInformationMessage('Open a terminal and run: ollama serve');
			} else if (action !== 'Continue Anyway') {
				return;
			}
		} else {
			vscode.window.showInformationMessage('CodeEcho: Ollama server is running');
		}

		const modelName = 'qwen2.5-coder';
		const modelInstalled = await checkModelInstalled(modelName);
		
		if (!modelInstalled) {
			const action = await vscode.window.showInformationMessage(
				`${modelName} model not found. Would you like to download it now? (This may take several minutes for the first download)`,
				'Download',
				'Skip'
			);
			
			if (action === 'Download') {
				vscode.window.showInformationMessage(`CodeEcho: Starting download of ${modelName} model...`);
				const success = await pullOllamaModel(modelName);
				if (!success) {
					const retryAction = await vscode.window.showErrorMessage(
						`Failed to download ${modelName} model.`,
						'Try Again',
						'Continue Anyway'
					);
					if (retryAction === 'Try Again') {
						await pullOllamaModel(modelName);
					}
				} else {
					vscode.window.showInformationMessage(`CodeEcho: ${modelName} model downloaded successfully.`);
				}
			}
		} else {
			vscode.window.showInformationMessage(`CodeEcho: ${modelName} model is ready.`);
		}
		
	} catch (error) {
		vscode.window.showErrorMessage(`CodeEcho: Error setting up Ollama: ${error}`);
	}
	
	// Get settings
	const config = vscode.workspace.getConfiguration('codeecho');
	
	const provider = new CodeEchoProvider();
	const prov = vscode.languages.registerInlineCompletionItemProvider(
		[
			{ scheme: 'file', language: 'python' },
			{ scheme: 'file', language: 'javascript' },
			{ scheme: 'file', language: 'typescript' },
			{ scheme: 'file', language: 'javascriptreact' },
			{ scheme: 'file', language: 'typescriptreact' },
			{ scheme: 'file', language: 'html' },
			{ scheme: 'file', language: 'css' }
		],
		provider
	);
	
	// Register a command to manually trigger suggestions
	const triggerCmd = vscode.commands.registerCommand('codeecho.triggerSuggestion', async () => {
		const editor = vscode.window.activeTextEditor;
		if (editor) {
			vscode.commands.executeCommand('editor.action.inlineSuggest.trigger');
			vscode.window.showInformationMessage('CodeEcho: Suggestions triggered');
		}
	});
	
	// Register a command to clear the cache
	const clearCacheCmd = vscode.commands.registerCommand('codeecho.clearCache', () => {
		provider.clearCache();
	});
	
	ctx.subscriptions.push(prov, triggerCmd, clearCacheCmd);
}

export function deactivate() {
}
