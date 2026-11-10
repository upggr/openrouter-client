import assert from 'node:assert/strict';
import { test } from 'node:test';

const manifest = require('../../package.json') as {
	contributes: {
		chatParticipants: { id: string; name: string; fullName: string }[];
	};
};

test('chat participant names are valid and the display name stays friendly', () => {
	assert.ok(manifest.contributes.chatParticipants.length > 0);
	for (const participant of manifest.contributes.chatParticipants) {
		assert.match(participant.name, /^[\w-]+$/, `${participant.id} has an invalid name`);
		assert.equal(participant.fullName, 'OpenRouter Client');
	}
});
