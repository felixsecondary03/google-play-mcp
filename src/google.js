// @ts-check
import { androidpublisher, auth as googleAuth } from '@googleapis/androidpublisher';
import { playdeveloperreporting } from '@googleapis/playdeveloperreporting';

export const SCOPES = [
  'https://www.googleapis.com/auth/androidpublisher',
  'https://www.googleapis.com/auth/playdeveloperreporting',
];

/**
 * @typedef {import('@googleapis/androidpublisher').androidpublisher_v3.Androidpublisher} Publisher
 * @typedef {import('@googleapis/playdeveloperreporting').playdeveloperreporting_v1beta1.Playdeveloperreporting} Reporting
 * @typedef {{ publisher: Publisher, reporting: Reporting, clientEmail: string }} GoogleClients
 */

/**
 * @param {import('./credentials.js').ServiceAccountKey} key
 * @returns {GoogleClients}
 */
export function createGoogleClients(key) {
  const authClient = new googleAuth.JWT({
    email: key.client_email,
    key: key.private_key,
    scopes: SCOPES,
  });
  const options = {
    auth: authClient,
    timeout: 120_000,
    retryConfig: { retry: 3, statusCodesToRetry: [[429, 429], [500, 599]] },
  };
  return {
    // @ts-ignore - the JWT client is accepted at runtime by both generated clients
    publisher: androidpublisher({ version: 'v3', ...options }),
    // @ts-ignore
    reporting: playdeveloperreporting({ version: 'v1beta1', ...options }),
    clientEmail: key.client_email,
  };
}

/**
 * Turn Google API errors into actionable messages.
 * @param {unknown} err
 * @param {string} [clientEmail]
 */
export function describeGoogleError(err, clientEmail) {
  /** @type {any} */
  const e = err;
  const status = e?.response?.status ?? e?.status ?? e?.code;
  const apiError = e?.response?.data?.error;
  let message =
    (typeof apiError === 'object' ? apiError?.message : undefined) ??
    (typeof apiError === 'string' ? `${apiError}: ${e?.response?.data?.error_description ?? ''}` : undefined) ??
    e?.message ??
    String(err);
  const reason = apiError?.errors?.[0]?.reason ?? apiError?.status;

  /** @type {string[]} */
  const hints = [];
  const who = clientEmail ? `the service account ${clientEmail}` : 'the service account';
  const lower = String(message).toLowerCase();

  if (lower.includes('invalid_grant') || lower.includes('invalid jwt') || lower.includes('account not found')) {
    hints.push('The JSON key is invalid, was deleted or revoked. Create a new key for the service account in Google Cloud Console.');
  } else if (lower.includes('has not been used in project') || lower.includes('is disabled') || reason === 'accessNotConfigured' || lower.includes('service_disabled')) {
    hints.push(
      'Enable the API in the Google Cloud project of the service account: "Google Play Android Developer API" ' +
        '(androidpublisher.googleapis.com) and, for list_apps / vitals tools, "Google Play Developer Reporting API" ' +
        '(playdeveloperreporting.googleapis.com). Changes can take a few minutes to propagate.'
    );
  } else if (status === 401 || status === 403 || lower.includes('permission') || lower.includes('caller does not have')) {
    hints.push(
      `Make sure ${who} is invited in Play Console → Users and permissions with access to this app ` +
        '(and the needed permissions, e.g. "View app information", "Reply to reviews", "Release to production", "View financial data"). ' +
        'New invites can take up to 24-36 hours to become effective for API access.'
    );
  } else if (status === 404 || lower.includes('package not found') || lower.includes('no application was found')) {
    hints.push(`Check the packageName and that ${who} has access to that app in Play Console.`);
  }
  if (lower.includes('changesnotsentforreview')) {
    hints.push('Retry with changesNotSentForReview: true; the changes are then saved and must be sent for review manually in Play Console.');
  }
  if (lower.includes('only releases with status draft may be created on draft app')) {
    hints.push('This app has never been published. Use status "draft" and finish the first release in Play Console.');
  }

  return [`Google Play API error${status ? ` (${status})` : ''}: ${message}`, ...hints.map((h) => `Hint: ${h}`)].join('\n');
}
