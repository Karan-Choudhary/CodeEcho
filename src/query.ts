import fetch from 'node-fetch';
import * as vscode from 'vscode';

export async function queryLocalModel(context: string): Promise<string[]> {
    const config = vscode.workspace.getConfiguration('codeecho');
    const endpoint = config.get<string>('endpoint')!;

    
    try {        
        const requestBody = JSON.stringify({
            model: 'qwen2.5-coder:7b',
            messages: [
                {
                    "role": "user",
                    "content": "You are a code completion assistant. Your task is to ONLY complete the remaining part of the code. IMPORTANT RULES:\n" +
                        "1. NEVER repeat any code that is already written\n" +
                        "2. ONLY provide the part that should come AFTER the cursor\n" +
                        "3. If the existing code is 'def square(', you should ONLY return 'number): return number ** 2'\n" +
                        "4. DO NOT include any markdown formatting\n" +
                        "5. DO NOT include any explanations or comments\n" +
                        "6. Preserve the indentation level of the current line\n" +
                        "7. For new lines, use the same indentation as the current line\n" +
                        "Here is the context:\n" + context,
                },
            ],
            stream: false
        });
        
        const resp = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }, // Changed from application/x-www-form-urlencoded
            body: requestBody
        });
        
        if (!resp.ok) {
            const errorText = await resp.text();
            console.error("CodeEcho: Error response body:", errorText);
            throw new Error(`Model server error: ${resp.status} ${resp.statusText} - ${errorText}`);
        }

        const data = await resp.json();
        
        if (!data.message || !data.message.content) {
            console.error("CodeEcho: Unexpected response format:", JSON.stringify(data).substring(0, 200));
            throw new Error("Unexpected response format from model");
        }
        
        let content = data.message.content;
        content = content.replace(/```[\w]*\n/g, '').replace(/```/g, ''); // Remove markdown
        content = content.trim();
        
        // Extract the last line of the existing code to check for duplicates
        const lastLine = context.split('\n').find(line => line.startsWith('EXISTING CODE'));
        if (lastLine) {
            const existingCode = lastLine.replace('EXISTING CODE (DO NOT REPEAT THIS):', '').trim();            
            if (content.startsWith(existingCode)) {
                content = content.slice(existingCode.length);
            }
        }

        // Get the indentation of the current line
        const currentLine = context.split('\n').find(line => line.startsWith('EXISTING CODE'));
        let baseIndentation = '';
        if (currentLine) {
            const match = currentLine.match(/^(\s*)/);
            if (match) {
                baseIndentation = match[1];
            }
        }

        // Fix indentation
        const lines = content.split('\n');
        const fixedLines = lines.map((line: string, index: number) => {
            // First line should have no indentation (it continues the current line)
            if (index === 0) {
                return line.trimLeft();
            }
            // Other lines should have the base indentation plus any additional indentation
            const lineIndentation = line.match(/^(\s*)/)?.[1] || '';
            const content = line.trimLeft();
            return baseIndentation + lineIndentation + content;
        });
        
        content = fixedLines.join('\n');
        
        if (content.trim() === '') {
            return [];
        }
        console.log("CodeEcho: Returning content:", content);
        return [content];
    } catch (err) {
        vscode.window.showErrorMessage(`CodeEcho: Error querying model: ${err}`);
        return [];
    }
}
