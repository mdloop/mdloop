import nodemailer from 'nodemailer';
import { describe, expect, it } from 'vitest';
import { SmtpEmailAdapter } from './smtp-email.adapter.js';

/**
 * `streamTransport: true, buffer: true` captures the fully-rendered MIME
 * message in memory instead of opening a real SMTP connection — no network
 * access or SMTP server needed, same "real library, mocked only at the
 * transport boundary" instinct as s3-storage.request.test.ts's
 * ScriptedTransport.
 *
 * `sendMail`'s resolved `info.message` is the raw rendered MIME buffer —
 * wrapping it here lets every test below assert on the actual rendered
 * headers/body rather than the adapter's internal call arguments.
 */
function captureAdapter(): { adapter: SmtpEmailAdapter; sent: () => Buffer | undefined } {
  const transporter = nodemailer.createTransport({ streamTransport: true, buffer: true });
  let lastMessage: Buffer | undefined;
  const original = transporter.sendMail.bind(transporter);
  transporter.sendMail = async (...args: Parameters<typeof original>) => {
    const info = await original(...args);
    lastMessage = info.message as Buffer;
    return info;
  };

  const adapter = new SmtpEmailAdapter({
    host: 'unused',
    port: 0,
    secure: false,
    from: 'noreply@mdloop.test',
    transporter,
  });
  return { adapter, sent: () => lastMessage };
}

function internalTransporter(adapter: SmtpEmailAdapter): nodemailer.Transporter {
  return (adapter as unknown as { transporter: nodemailer.Transporter }).transporter;
}

describe('SmtpEmailAdapter', () => {
  it('sends an idle-warning email with the org name and purge date', async () => {
    const { adapter, sent } = captureAdapter();
    const purgeAt = new Date('2026-09-01T00:00:00.000Z');

    await adapter.sendIdleWarning('owner@example.com', 'Acme Org', purgeAt);

    const text = sent()?.toString('utf8') ?? '';
    expect(text).toContain('To: owner@example.com');
    expect(text).toContain('Acme Org');
    expect(text).toContain(purgeAt.toISOString());
  });

  it('sends an org-invite email with the accept link and expiry', async () => {
    const { adapter, sent } = captureAdapter();
    const expiresAt = new Date('2026-08-24T00:00:00.000Z');

    await adapter.sendOrgInvite(
      'invitee@example.com',
      'Acme Org',
      'https://mdloop.example/invite/accept?token=abc123',
      expiresAt,
    );

    const text = sent()?.toString('utf8') ?? '';
    expect(text).toContain('To: invitee@example.com');
    expect(text).toContain('Acme Org');
    expect(text).toContain('https://mdloop.example/invite/accept?token=abc123');
    expect(text).toContain(expiresAt.toISOString());
  });

  it('sends a guest-share email with the document title and url, no document content', async () => {
    const { adapter, sent } = captureAdapter();
    const expiresAt = new Date('2026-08-30T00:00:00.000Z');

    await adapter.sendGuestShare({
      to: 'guest@example.com',
      documentTitle: 'Q3 Roadmap',
      url: 'https://mdloop.example/g/tok123',
      expiresAt,
    });

    const text = sent()?.toString('utf8') ?? '';
    expect(text).toContain('To: guest@example.com');
    expect(text).toContain('Q3 Roadmap');
    expect(text).toContain('https://mdloop.example/g/tok123');
    expect(text).toContain(expiresAt.toISOString());
  });

  it('builds a real SMTP transport from host/port/secure/auth when no transporter is injected', () => {
    const adapter = new SmtpEmailAdapter({
      host: 'smtp.example.com',
      port: 587,
      secure: false,
      user: 'user',
      pass: 'pass',
      from: 'noreply@mdloop.test',
    });
    const options = (
      internalTransporter(adapter) as unknown as { options?: Record<string, unknown> }
    ).options;
    expect(options?.host).toBe('smtp.example.com');
    expect(options?.port).toBe(587);
    expect(options?.auth).toEqual({ user: 'user', pass: 'pass' });
  });

  it('omits auth entirely when user/pass are not provided (no-auth relay, e.g. local Mailhog)', () => {
    const adapter = new SmtpEmailAdapter({
      host: 'localhost',
      port: 1025,
      secure: false,
      from: 'noreply@mdloop.test',
    });
    const options = (
      internalTransporter(adapter) as unknown as { options?: Record<string, unknown> }
    ).options;
    expect(options?.auth).toBeUndefined();
  });
});
