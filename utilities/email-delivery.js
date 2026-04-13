const query = require('../db/db');
const keys = require('../config/keys');
const constants = require('../config/const');
const nodemailer = require('nodemailer');
const { SESv2Client, SendEmailCommand } = require('@aws-sdk/client-sesv2');
const { getAppConfig } = require('./app-config');
const { renderEmailTemplate } = require('./email-template');

const MAX_EMAIL_DELIVERY_ATTEMPTS = 3;

let emailLogTableReadyPromise = null;

async function sendPriceUpdateEmail(track, options = {}) {
  const renderedEmail = await renderEmailTemplate('price_change', {
    productName: track.product_name,
    productUrl: track.price_url,
    originalPrice: track.orig_price,
    previousPrice: options.previousPrice,
    currentPrice: track.curr_price
  });

  return queueEmail({
    track_id: track.id,
    product_name: track.product_name,
    orig_price: track.orig_price,
    curr_price: track.curr_price,
    email: track.email,
    email_type: 'price_change',
    template_key: renderedEmail.templateKey,
    delivered: false,
    created_at: new Date(),
    subject: renderedEmail.subject,
    body: renderedEmail.text,
    html_body: renderedEmail.html
  });
}

async function sendTrackInactiveEmail(track) {
  const renderedEmail = await renderEmailTemplate('track_inactive', {
    productName: track.product_name,
    productUrl: track.price_url,
    originalPrice: track.orig_price
  });

  return queueEmail({
    track_id: track.id,
    product_name: track.product_name,
    orig_price: track.orig_price,
    curr_price: null,
    email: track.email,
    email_type: 'track_inactive',
    template_key: renderedEmail.templateKey,
    delivered: false,
    created_at: new Date(),
    subject: renderedEmail.subject,
    body: renderedEmail.text,
    html_body: renderedEmail.html
  });
}

async function sendImmediateTemplateEmail({
  templateKey,
  recipientEmail,
  emailType = templateKey,
  trackId = null,
  productName = null,
  originalPrice = null,
  currentPrice = null,
  templateData = {}
}) {
  const renderedEmail = await renderEmailTemplate(templateKey, templateData);

  const email = {
    track_id: trackId,
    product_name: productName,
    orig_price: originalPrice,
    curr_price: currentPrice,
    email: recipientEmail,
    email_type: emailType,
    template_key: renderedEmail.templateKey,
    delivered: false,
    created_at: new Date(),
    status: 'pending',
    subject: renderedEmail.subject,
    body: renderedEmail.text,
    html_body: renderedEmail.html
  };

  const emailLog = await insertEmail(email);
  if (!emailLog) {
    throw new Error('Failed to create email log');
  }

  const deliveryContext = await createEmailTransport({});
  const deliveryResult = await deliverPendingEmail(emailLog, deliveryContext);

  if (deliveryResult.status !== 'sent') {
    throw new Error('Failed to send email');
  }

  return {
    emailLogId: emailLog.id,
    recipient: recipientEmail,
    subject: renderedEmail.subject,
    status: deliveryResult.status
  };
}

async function sendTemplateTestEmail({
  templateKey,
  recipientEmail,
  productName,
  productUrl,
  originalPrice = null,
  previousPrice = null,
  currentPrice = null
}) {
  return sendImmediateTemplateEmail({
    templateKey,
    recipientEmail,
    emailType: templateKey,
    productName,
    originalPrice,
    currentPrice,
    templateData: {
      productName,
      productUrl,
      originalPrice,
      previousPrice,
      currentPrice
    }
  });
}

async function ensureEmailLogTable() {
  if (!emailLogTableReadyPromise) {
    emailLogTableReadyPromise = ensureEmailLogTableColumns().catch((error) => {
      emailLogTableReadyPromise = null;
      throw error;
    });
  }

  await emailLogTableReadyPromise;
}

async function ensureEmailLogTableColumns() {
  await query(`
    CREATE TABLE IF NOT EXISTS email_logs (
      "id" serial PRIMARY KEY,
      "track_id" integer,
      "product_name" varchar(64),
      "orig_price" numeric,
      "curr_price" numeric,
      "email" varchar(256),
      "email_type" varchar(64),
      "template_key" varchar(64),
      "status" varchar(32),
      "subject" text,
      "body" text,
      "html_body" text,
      "error_message" text,
      "delivered" boolean,
      "sent_at" timestamp,
      "attempt_count" integer NOT NULL DEFAULT 0,
      "last_attempt_at" timestamp,
      "next_send_at" timestamp,
      "created_at" timestamp
    )
  `);

  await query(`
    ALTER TABLE email_logs
      ADD COLUMN IF NOT EXISTS track_id integer,
      ADD COLUMN IF NOT EXISTS product_name varchar(64),
      ADD COLUMN IF NOT EXISTS orig_price numeric,
      ADD COLUMN IF NOT EXISTS curr_price numeric,
      ADD COLUMN IF NOT EXISTS email varchar(256),
      ADD COLUMN IF NOT EXISTS email_type varchar(64),
      ADD COLUMN IF NOT EXISTS template_key varchar(64),
      ADD COLUMN IF NOT EXISTS status varchar(32),
      ADD COLUMN IF NOT EXISTS subject text,
      ADD COLUMN IF NOT EXISTS body text,
      ADD COLUMN IF NOT EXISTS html_body text,
      ADD COLUMN IF NOT EXISTS error_message text,
      ADD COLUMN IF NOT EXISTS delivered boolean,
      ADD COLUMN IF NOT EXISTS sent_at timestamp,
      ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS last_attempt_at timestamp,
      ADD COLUMN IF NOT EXISTS next_send_at timestamp,
      ADD COLUMN IF NOT EXISTS created_at timestamp
  `);
}

async function insertEmail(email) {
  try {
    await ensureEmailLogTable();
    const result = await query(
      `INSERT INTO email_logs (
        track_id,
        product_name,
        orig_price,
        curr_price,
        email,
        email_type,
        template_key,
        status,
        subject,
        body,
        html_body,
        error_message,
        delivered,
        sent_at,
        attempt_count,
        last_attempt_at,
        next_send_at,
        created_at
      )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
       RETURNING *`,
      [
        email.track_id,
        email.product_name,
        email.orig_price,
        email.curr_price,
        email.email,
        email.email_type || 'generic',
        email.template_key || null,
        email.status || (email.delivered ? 'sent' : 'pending'),
        email.subject || null,
        email.body || null,
        email.html_body || null,
        email.error_message || null,
        email.delivered,
        email.sent_at || null,
        Number.isFinite(email.attempt_count) ? email.attempt_count : 0,
        email.last_attempt_at || null,
        email.next_send_at || email.created_at || new Date(),
        email.created_at
      ]
    );

    console.info('[email] Email log inserted', {
      emailLogId: result.rows[0].id,
      trackId: email.track_id,
      status: result.rows[0].status
    });
    return result.rows[0];
  } catch (error) {
    console.error('[email] Failed to insert email log', {
      trackId: email.track_id,
      recipient: email.email,
      error
    });
    return null;
  }
}

async function queueEmail(email) {
  const startedAt = Date.now();
  const queuedAt = email.created_at || new Date();
  email.created_at = queuedAt;
  email.delivered = false;
  email.status = 'pending';
  email.error_message = null;
  email.sent_at = null;
  email.attempt_count = 0;
  email.last_attempt_at = null;
  email.next_send_at = queuedAt;
  await insertEmail(email);
  return Date.now() - startedAt;
}

async function getPendingEmailLogs(options = {}) {
  await ensureEmailLogTable();
  const whereClause = options.ignoreSchedule
    ? `status IN ('pending', 'skipped_disabled', 'skipped_missing_config')`
    : `status IN ('pending', 'skipped_disabled', 'skipped_missing_config')
       AND (next_send_at IS NULL OR next_send_at <= NOW())`;
  const result = await query(
    `SELECT *
     FROM email_logs
     WHERE ${whereClause}
     ORDER BY created_at ASC NULLS LAST, id ASC`
  );

  return result.rows;
}

async function getPendingEmailCount() {
  await ensureEmailLogTable();
  const result = await query(
    `SELECT COUNT(*)::int AS total
     FROM email_logs
     WHERE status IN ('pending', 'skipped_disabled', 'skipped_missing_config')`
  );

  return result.rows[0] ? result.rows[0].total : 0;
}

async function updateEmailLog(emailLogId, {
  status,
  errorMessage = null,
  delivered = false,
  sentAt = null,
  attemptCount = 0,
  lastAttemptAt = null,
  nextSendAt = null
}) {
  await ensureEmailLogTable();
  await query(
    `UPDATE email_logs
     SET status = $2,
         error_message = $3,
         delivered = $4,
         sent_at = $5,
         attempt_count = $6,
         last_attempt_at = $7,
         next_send_at = $8
     WHERE id = $1`,
    [
      emailLogId,
      status,
      errorMessage,
      delivered,
      sentAt,
      attemptCount,
      lastAttemptAt,
      nextSendAt
    ]
  );
}

async function getEmailRetryDelayMs() {
  const retryDelayMs = await getAppConfig('email.retry_delay_ms', constants.email.retryDelayMs);
  return Number.isFinite(retryDelayMs) && retryDelayMs >= 0
    ? retryDelayMs
    : constants.email.retryDelayMs;
}

async function deliverPendingEmails(options = {}) {
  const allPendingCount = await getPendingEmailCount();
  const pendingEmails = await getPendingEmailLogs(options);
  const deferredCount = Math.max(0, allPendingCount - pendingEmails.length);

  if (pendingEmails.length === 0) {
    return {
      pendingCount: allPendingCount,
      dueCount: 0,
      deferredCount,
      sentCount: 0,
      undeliverableCount: 0,
      skippedCount: 0
    };
  }

  const sendEmailsEnabled = await getAppConfig('email.send_enabled', constants.email.sendEmail);
  if (!sendEmailsEnabled) {
    console.info('[email] Pending email delivery skipped because email sending is disabled', {
      pendingCount: allPendingCount,
      dueCount: pendingEmails.length
    });
    return {
      pendingCount: allPendingCount,
      dueCount: pendingEmails.length,
      deferredCount,
      sentCount: 0,
      undeliverableCount: 0,
      skippedCount: pendingEmails.length
    };
  }

  const configuredTransportMode = await getEmailTransportMode();
  let deliveryContext = null;

  try {
    deliveryContext = await createEmailTransport({ transportMode: configuredTransportMode });
  } catch (error) {
    if (error && error.code === 'EMAIL_CONFIG_MISSING') {
      console.error('[email] Pending email delivery skipped because configuration is incomplete', {
        pendingCount: allPendingCount,
        dueCount: pendingEmails.length,
        transportMode: configuredTransportMode,
        ...(error.details || {})
      });
      return {
        pendingCount: allPendingCount,
        dueCount: pendingEmails.length,
        deferredCount,
        sentCount: 0,
        undeliverableCount: 0,
        skippedCount: pendingEmails.length
      };
    }

    throw error;
  }

  const summary = {
    pendingCount: allPendingCount,
    dueCount: pendingEmails.length,
    deferredCount,
    sentCount: 0,
    undeliverableCount: 0,
    skippedCount: 0
  };

  for (const pendingEmail of pendingEmails) {
    const deliveryResult = await deliverPendingEmail(pendingEmail, deliveryContext);

    if (deliveryResult.status === 'sent') {
      summary.sentCount += 1;
    } else if (deliveryResult.status === 'undeliverable') {
      summary.undeliverableCount += 1;
    } else {
      summary.skippedCount += 1;
    }
  }

  console.info('[email] Pending email delivery finished', summary);
  return summary;
}

async function deliverPendingEmail(emailLog, deliveryContext) {
  let attemptCount = Number(emailLog.attempt_count) || 0;
  const retryDelayMs = await getEmailRetryDelayMs();

  if (attemptCount >= MAX_EMAIL_DELIVERY_ATTEMPTS) {
    await updateEmailLog(emailLog.id, {
      status: 'undeliverable',
      errorMessage: emailLog.error_message || `Failed to deliver after ${MAX_EMAIL_DELIVERY_ATTEMPTS} attempts.`,
      delivered: false,
      sentAt: null,
      attemptCount,
      lastAttemptAt: emailLog.last_attempt_at || new Date(),
      nextSendAt: null
    });
    return { status: 'undeliverable' };
  }

  while (attemptCount < MAX_EMAIL_DELIVERY_ATTEMPTS) {
    attemptCount += 1;
    const attemptedAt = new Date();

    try {
      const info = await sendQueuedEmailWithContext(emailLog, deliveryContext);

      await updateEmailLog(emailLog.id, {
        status: 'sent',
        errorMessage: null,
        delivered: true,
        sentAt: new Date(),
        attemptCount,
        lastAttemptAt: attemptedAt,
        nextSendAt: null
      });

      console.info('[email] Email sent', {
        emailLogId: emailLog.id,
        trackId: emailLog.track_id,
        recipient: emailLog.email,
        transportMode: deliveryContext.transportMode,
        attemptCount,
        response: info.response || info.messageId || null
      });

      return { status: 'sent' };
    } catch (error) {
      const hasAttemptsRemaining = attemptCount < MAX_EMAIL_DELIVERY_ATTEMPTS;
      const status = hasAttemptsRemaining ? 'pending' : 'undeliverable';
      const nextSendAt = hasAttemptsRemaining
        ? new Date(attemptedAt.getTime() + retryDelayMs)
        : null;

      await updateEmailLog(emailLog.id, {
        status,
        errorMessage: error.message,
        delivered: false,
        sentAt: null,
        attemptCount,
        lastAttemptAt: attemptedAt,
        nextSendAt
      });

      console.error('[email] Failed to deliver queued email', {
        emailLogId: emailLog.id,
        trackId: emailLog.track_id,
        recipient: emailLog.email,
        transportMode: deliveryContext.transportMode,
        attemptCount,
        status,
        error
      });

      if (!hasAttemptsRemaining) {
        return { status: 'undeliverable' };
      }
    }
  }

  return { status: 'undeliverable' };
}

async function sendQueuedEmailWithContext(emailLog, deliveryContext) {
  if (deliveryContext.transportMode === 'ses') {
    const emailBody = {};

    if (emailLog.body) {
      emailBody.Text = {
        Data: emailLog.body,
        Charset: 'UTF-8'
      };
    }

    if (emailLog.html_body) {
      emailBody.Html = {
        Data: emailLog.html_body,
        Charset: 'UTF-8'
      };
    }

    const command = new SendEmailCommand({
      FromEmailAddress: deliveryContext.senderAddress,
      Destination: {
        ToAddresses: [emailLog.email]
      },
      Content: {
        Simple: {
          Subject: {
            Data: emailLog.subject || '',
            Charset: 'UTF-8'
          },
          Body: emailBody
        }
      }
    });

    const response = await deliveryContext.sesClient.send(command);
    return {
      messageId: response.MessageId || null,
      response: response.MessageId || null
    };
  }

  return deliveryContext.transporter.sendMail({
    from: deliveryContext.senderAddress,
    to: emailLog.email,
    subject: emailLog.subject,
    text: emailLog.body,
    html: emailLog.html_body || undefined
  });
}

async function createEmailTransport({ emailAddress, transportMode = null }) {
  const resolvedTransportMode = transportMode || await getEmailTransportMode();
  const resolvedEmailAddress = resolvedTransportMode === 'ses'
    ? await getAppConfig('email.ses_address', constants.email.sesAddress)
    : (emailAddress || await getAppConfig('email.address', keys.email && keys.email.address));

  if (!resolvedEmailAddress) {
    throw createMissingEmailConfigError(
      resolvedTransportMode === 'ses'
        ? 'Email configuration is incomplete. Expected email.ses_address for outgoing SES mail.'
        : 'Email configuration is incomplete. Expected email.address for outgoing mail.',
      {
        transportMode: resolvedTransportMode,
        hasAddress: Boolean(resolvedEmailAddress)
      }
    );
  }

  if (resolvedTransportMode === 'ses') {
    const awsConfig = getAwsMailConfig();

    if (!awsConfig.accessKeyId || !awsConfig.secretAccessKey || !awsConfig.region) {
      throw createMissingEmailConfigError(
        'Email configuration is incomplete for SES. Expected aws access key, secret access key and region.',
        {
          transportMode: resolvedTransportMode,
          hasAccessKeyId: Boolean(awsConfig.accessKeyId),
          hasSecretAccessKey: Boolean(awsConfig.secretAccessKey),
          hasRegion: Boolean(awsConfig.region)
        }
      );
    }

    return {
      senderAddress: resolvedEmailAddress,
      transportMode: resolvedTransportMode,
      sesClient: new SESv2Client({
        region: awsConfig.region,
        credentials: {
          accessKeyId: awsConfig.accessKeyId,
          secretAccessKey: awsConfig.secretAccessKey
        }
      })
    };
  }

  const emailService = await getAppConfig('email.service', keys.email && keys.email.service);
  const emailPassword = await getAppConfig('email.password', keys.email && keys.email.password);

  if (!emailService || !emailPassword) {
    throw createMissingEmailConfigError(
      'Email configuration is incomplete for SMTP. Expected email.service, email.address and email.password.',
      {
        transportMode: resolvedTransportMode,
        hasService: Boolean(emailService),
        hasAddress: Boolean(resolvedEmailAddress),
        hasPassword: Boolean(emailPassword)
      }
    );
  }

  return {
    senderAddress: resolvedEmailAddress,
    transportMode: resolvedTransportMode,
    transporter: nodemailer.createTransport({
      service: emailService,
      connectionTimeout: 15000,
      greetingTimeout: 15000,
      socketTimeout: 20000,
      auth: {
        user: resolvedEmailAddress,
        pass: emailPassword
      }
    })
  };
}

async function getEmailTransportMode() {
  const configuredTransportMode = await getAppConfig('email.transport_mode', constants.email.transportMode);
  return normalizeEmailTransportMode(configuredTransportMode);
}

function normalizeEmailTransportMode(value) {
  const normalizedValue = String(value || '').trim().toLowerCase();
  return normalizedValue === 'ses' ? 'ses' : 'smtp';
}

function createMissingEmailConfigError(message, details) {
  const error = new Error(message);
  error.code = 'EMAIL_CONFIG_MISSING';
  error.details = details;
  return error;
}

function getAwsMailConfig() {
  const awsConfig = keys.aws || {};
  return {
    accessKeyId: awsConfig.AWS_ACCESS_KEY_ID || awsConfig.accessKeyId || process.env.AWS_ACCESS_KEY_ID || '',
    secretAccessKey: awsConfig.AWS_SECRET_ACCESS_KEY || awsConfig.secretAccessKey || process.env.AWS_SECRET_ACCESS_KEY || '',
    region: awsConfig.AWS_REGION || awsConfig.region || process.env.AWS_REGION || ''
  };
}

module.exports = {
  deliverPendingEmails,
  ensureEmailLogTable,
  sendImmediateTemplateEmail,
  sendPriceUpdateEmail,
  sendTemplateTestEmail,
  sendTrackInactiveEmail
};
