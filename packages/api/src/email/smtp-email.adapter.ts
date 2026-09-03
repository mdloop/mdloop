import nodemailer from 'nodemailer';
import type { EmailPort } from '@vorlyn/app';

export interface SmtpEmailAdapterConfig {
  readonly host: string;
  readonly port: number;
  readonly secure: boolean;
  /** Some relays (e.g. a local dev Mailhog) need no auth — both optional. */
  readonly user?: string;
  readonly pass?: string;
  /** The From address every email is sent as. */
  readonly from: string;
  /**
   * Escape hatch for tests: inject a pre-built nodemailer `Transporter`
   * (e.g. one built with `streamTransport: true` — no real SMTP server or
   * network access needed) instead of letting this class build a real SMTP
   * transport from `host`/`port`/`secure`/`user`/`pass`. Never set in
   * production wiring — same shape as `S3StorageConfig.client`.
   */
  readonly transporter?: nodemailer.Transporter;
}

/**
 * SMTP-backed email adapter for self-hosted Vorlyn instances (open-source
 * release track) — the self-host equivalent of a hypothetical SES adapter,
 * for operators who'd rather point at their own mail relay. Every method
 * mirrors `LoggingEmailAdapter`'s signatures exactly; unlike that noop, this
 * one actually sends.
 *
 * Content policy (EmailPort's own doc comment, CONSTITUTION.md §3 "no org
 * data in logs" extended to "no document content in email"): every body
 * below is built only from what `EmailPort`'s method signatures hand this
 * class — titles, names, links, dates — never document content. The port's
 * types structurally can't pass content through, so this isn't an adapter
 * choice to police, it's enforced by what's available to write with.
 *
 * Not wired into any composition root — that's the self-host composition
 * root's job in a later phase.
 */
export class SmtpEmailAdapter implements EmailPort {
  private readonly transporter: nodemailer.Transporter;
  private readonly from: string;

  constructor(config: SmtpEmailAdapterConfig) {
    this.from = config.from;
    this.transporter =
      config.transporter ??
      nodemailer.createTransport({
        host: config.host,
        port: config.port,
        secure: config.secure,
        ...(config.user !== undefined && config.pass !== undefined
          ? { auth: { user: config.user, pass: config.pass } }
          : {}),
      });
  }

  async sendIdleWarning(to: string, orgName: string, purgeAt: Date): Promise<void> {
    await this.transporter.sendMail({
      from: this.from,
      to,
      subject: `Action needed: ${orgName} will be purged soon`,
      text: [
        `Your organization "${orgName}" has been idle and is scheduled for purge on ${purgeAt.toISOString()}.`,
        'Sign in before then to keep it active.',
      ].join('\n'),
    });
  }

  async sendOrgInvite(
    to: string,
    orgName: string,
    acceptUrl: string,
    expiresAt: Date,
  ): Promise<void> {
    await this.transporter.sendMail({
      from: this.from,
      to,
      subject: `You've been invited to join ${orgName} on Vorlyn`,
      text: [
        `You've been invited to join "${orgName}" on Vorlyn.`,
        `Accept the invite: ${acceptUrl}`,
        `This invite expires on ${expiresAt.toISOString()}.`,
      ].join('\n'),
    });
  }

  async sendGuestShare(input: {
    to: string;
    documentTitle: string;
    url: string;
    expiresAt: Date;
  }): Promise<void> {
    await this.transporter.sendMail({
      from: this.from,
      to: input.to,
      subject: `"${input.documentTitle}" was shared with you on Vorlyn`,
      text: [
        `"${input.documentTitle}" was shared with you on Vorlyn.`,
        `View it: ${input.url}`,
        `This link expires on ${input.expiresAt.toISOString()}.`,
      ].join('\n'),
    });
  }
}
