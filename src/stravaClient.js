import https from 'https';
import { decode } from 'html-entities';

/**
 * Internal helper function to make HTTP requests
 * @param {Object} options - Request options
 * @param {number} timeout - Request timeout in milliseconds
 * @returns {Promise<string>} Response data
 */
function makeRequest(options, timeout, maxRedirects = 5) {
    return new Promise((resolve, reject) => {
        const requestOptions = {
            ...options,
            timeout: timeout,
        };

        const req = https.request(requestOptions, (res) => {
            let data = '';

            // Handle redirects (e.g. /dashboard -> /dashboard?dashboard_next=1)
            if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
                res.resume();
                if (res.headers.location.includes('/login')) {
                    const error = new Error(`HTTP ${res.statusCode}: Redirected to login (invalid or expired session cookie)`);
                    error.statusCode = res.statusCode;
                    reject(error);
                    return;
                }
                if (maxRedirects <= 0) {
                    reject(new Error('Too many redirects'));
                    return;
                }
                const redirectUrl = new URL(res.headers.location, `https://${options.hostname}`);
                const redirectOptions = {
                    ...options,
                    hostname: redirectUrl.hostname,
                    path: redirectUrl.pathname + redirectUrl.search,
                };
                resolve(makeRequest(redirectOptions, timeout, maxRedirects - 1));
                return;
            }

            // Handle non-200 status codes
            if (res.statusCode < 200 || res.statusCode >= 300) {
                const error = new Error(`HTTP ${res.statusCode}: ${res.statusMessage}`);
                error.statusCode = res.statusCode;
                reject(error);
                return;
            }

            res.on('data', (chunk) => {
                data += chunk;
            });

            res.on('end', () => {
                resolve(data);
            });
        });

        req.on('error', (e) => {
            reject(new Error(`Request failed: ${e.message}`));
        });

        req.on('timeout', () => {
            req.destroy();
            reject(new Error(`Request timeout after ${timeout}ms`));
        });

        req.setTimeout(timeout);
        req.end();
    });
}

/**
 * Get CSRF token from Strava dashboard
 * @param {string} cookieValue - Session cookie value
 * @param {number} timeout - Request timeout in milliseconds
 * @returns {Promise<string>} CSRF token
 */
async function getCsrfToken(cookieValue, timeout) {
    const options = {
        hostname: 'www.strava.com',
        path: '/dashboard',
        method: 'GET',
        headers: {
            Cookie: cookieValue,
        },
    };

    const data = await makeRequest(options, timeout);
    const csrfTokenMatch = data.match(/<meta name="csrf(?:-token)?" content="([^"]+)"/);

    if (csrfTokenMatch) {
        const csrfToken = csrfTokenMatch[1];
        return csrfToken;
    } else {
        throw new Error('CSRF Token not found in response - possibly invalid session cookie');
    }
}

/**
 * Transform group activity to standard activity format
 * @param {Object} activity - Group activity object
 * @returns {Object} Normalized activity object
 */
function transformGroupActivity(activity) {
    return {
        ...activity,
        activityName: activity.name,
        id: activity.activity_id,
        athlete: {
            athleteId: activity.athlete_id,
            athleteName: activity.athlete_name,
        },
        kudosAndComments: {
            hasKudoed: activity.has_kudoed,
        },
    };
}

/**
 * Extract activities from feed entries array
 * @param {Array} entries - Feed entries
 * @returns {Array} Normalized activities
 */
function extractActivitiesFromEntries(entries = []) {
    const activities = [];
    entries.forEach((entry) => {
        if (entry.entity === 'Activity' && entry.activity) {
            activities.push(entry.activity);
        } else if (entry.entity === 'GroupActivity' && entry.rowData?.activities) {
            activities.push(...entry.rowData.activities.map(transformGroupActivity));
        }
    });
    return activities;
}

/**
 * Parse activities from dashboard response (JSON feed, Next.js __NEXT_DATA__, or legacy data-react-props)
 * @param {string} responseData - Response from dashboard or feed endpoint
 * @returns {Array} Parsed activities
 */
function parseActivitiesFromDashboard(responseData) {
    let activities = [];

    // 1. Try parsing direct JSON feed response (/dashboard/feed)
    try {
        const parsedJson = JSON.parse(responseData);
        if (Array.isArray(parsedJson?.entries)) {
            activities.push(...extractActivitiesFromEntries(parsedJson.entries));
        }
    } catch {
        // Not direct JSON, try HTML formats below
    }

    // 2. Try Next.js __NEXT_DATA__ script tag (dashboard_next=1)
    if (activities.length === 0) {
        const nextDataMatch = responseData.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
        if (nextDataMatch) {
            try {
                const nextData = JSON.parse(nextDataMatch[1]);
                const entries = nextData?.props?.pageProps?.dashboardData?.feed?.entries || [];
                activities.push(...extractActivitiesFromEntries(entries));
            } catch (parseError) {
                console.warn('Failed to parse __NEXT_DATA__:', parseError.message);
            }
        }
    }

    // 3. Fallback to legacy data-react-props
    if (activities.length === 0) {
        const reactPropsMatches = [...responseData.matchAll(/data-react-props='([^']+)'/g)].map((match) => match[1]);

        reactPropsMatches.forEach((match) => {
            try {
                const reactProps = JSON.parse(decode(match));
                const entries = reactProps?.appContext?.feedProps?.preFetchedEntries || [];
                activities.push(...extractActivitiesFromEntries(entries));
            } catch (parseError) {
                console.warn('Failed to parse react props:', parseError.message);
            }
        });
    }

    if (activities.length === 0) throw new Error('No activities found - check session cookie validity');

    // Remove newlines from activity names
    activities = activities.map((activity) => ({
        ...activity,
        activityName: activity.activityName?.replace(/\n/g, ' ') || activity.activityName,
    }));

    return activities;
}

/**
 * Strava API client for authentication and data fetching
 */
export class StravaClient {
    constructor(sessionCookie, options = {}) {
        this.sessionCookie = sessionCookie;
        this.timeout = options.timeout || 30000; // 30 second timeout
        this.cookieValue = `_strava4_session=${sessionCookie}`;
        this.csrfToken = null;
    }

    /**
     * Initialize the client by fetching the CSRF token
     * @returns {Promise<void>}
     */
    async initialize() {
        this.csrfToken = await getCsrfToken(this.cookieValue, this.timeout);
    }

    /**
     * Get activities from Strava dashboard
     * @param {number} myAthleteID - User's athlete ID
     * @param {number} [numEntries=60] - Number of entries to fetch
     * @returns {Promise<Array>} Array of activities
     */
    async getActivitiesViaDashboard(myAthleteID, numEntries = 60) {
        if (!this.csrfToken) throw new Error('Client not initialized. Call initialize() first.');

        const options = {
            hostname: 'www.strava.com',
            path: `/dashboard/feed?feed_type=following&num_entries=${numEntries}`,
            method: 'GET',
            headers: {
                'Cookie': this.cookieValue,
                'x-csrf-token': this.csrfToken,
            },
        };

        const data = await makeRequest(options, this.timeout);
        return parseActivitiesFromDashboard(data);
    }

    /**
     * Send kudos to an activity
     * @param {string} activityId - Activity ID
     * @returns {Promise<string>} Response data
     */
    async sendKudos(activityId) {
        if (!this.csrfToken) throw new Error('Client not initialized. Call initialize() first.');

        const options = {
            hostname: 'www.strava.com',
            path: `/feed/activity/${activityId}/kudo`,
            method: 'POST',
            headers: {
                'Cookie': this.cookieValue,
                'x-csrf-token': this.csrfToken,
            },
        };

        return await makeRequest(options, this.timeout);
    }
}
