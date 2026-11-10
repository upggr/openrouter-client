import * as vscode from 'vscode';
import { GatewayModelProvider, VENDOR } from './vscode/lmProvider';
import { registerParticipant } from './vscode/participant';
import { Services } from './vscode/services';
import { ChatViewProvider } from './vscode/sidebar';

export function activate(context: vscode.ExtensionContext): void {
	const services = new Services(context);
	const chatView = new ChatViewProvider(context, services);

	context.subscriptions.push(
		services,
		chatView,
		vscode.window.registerWebviewViewProvider(ChatViewProvider.viewId, chatView, { webviewOptions: { retainContextWhenHidden: true } }),
		vscode.lm.registerLanguageModelChatProvider(VENDOR, new GatewayModelProvider(services)),
		registerParticipant(context, services),
		vscode.commands.registerCommand('openrouter.openChat', () => chatView.reveal()),
		vscode.commands.registerCommand('openrouter.newChat', () => chatView.startNew()),
		vscode.commands.registerCommand('openrouter.setApiKey', () => chatView.showSetup()),
		vscode.commands.registerCommand('openrouter.clearApiKey', () => services.clearApiKey()),
		vscode.commands.registerCommand('openrouter.switchApiKey', () => services.pickApiKey()),
		vscode.commands.registerCommand('openrouter.selectModel', () => services.pickModel()),
		vscode.commands.registerCommand('openrouter.setPermissionMode', () => services.pickMode()),
		vscode.commands.registerCommand('openrouter.askAboutSelection', () => chatView.askAboutSelection()),
		vscode.commands.registerCommand('openrouter.getSubscription', () => services.openSubscriptionPage()),
		vscode.commands.registerCommand('openrouter.showCredits', () => services.showCredits()),
		vscode.commands.registerCommand('openrouter.openMemory', () => services.openMemory()),
		vscode.commands.registerCommand('openrouter.exportChat', () => chatView.exportChat()),
		vscode.commands.registerCommand('openrouter.writeHandover', () => chatView.writeHandover()),
		vscode.commands.registerCommand('openrouter.resumeHandover', () => chatView.resumeHandover()),
	);
}

export function deactivate(): void {
	// Everything is released through context.subscriptions.
}
