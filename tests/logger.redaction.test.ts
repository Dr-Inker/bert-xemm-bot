import { Writable } from 'node:stream';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { loggerOptions } from '../src/logger.js';

describe('logger credential redaction', () => {
  it('redacts candidate and header API keys before serialization', () => {
    let output = '';
    const destination = new Writable({
      write(chunk, _encoding, callback) {
        output += chunk.toString();
        callback();
      },
    });
    const log = pino(loggerOptions, destination);
    log.info({
      apiKey: 'top-secret',
      candidate: { apiKey: 'nested-secret' },
      headers: { 'x-api-key': 'header-secret' },
      safe: 'visible',
    }, 'redaction test');

    expect(output).toContain('visible');
    expect(output).not.toContain('top-secret');
    expect(output).not.toContain('nested-secret');
    expect(output).not.toContain('header-secret');
    expect(output.match(/\[REDACTED\]/g)).toHaveLength(3);
  });
});
