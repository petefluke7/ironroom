/**
 * Application constants
 */

const IDENTITY_MODES = ['real_name', 'first_name', 'nickname'];

const PLAN_TYPES = ['monthly', 'yearly'];

const PLATFORMS = ['apple', 'google'];

const REPORT_REASONS = ['harassment', 'abuse', 'spam', 'other'];

const MATCH_STATUS = ['active', 'ended', 'blocked'];

const REPORT_STATUS = ['pending', 'reviewed', 'resolved'];

const MODERATOR_ROLES = ['moderator', 'admin'];

const SUSPENSION_DURATIONS = {
    '12h': 12 * 60 * 60 * 1000,
    '24h': 24 * 60 * 60 * 1000,
    '3d': 3 * 24 * 60 * 60 * 1000,
    '7d': 7 * 24 * 60 * 60 * 1000,
};

const MATCH_SCORING = {
    SHARED_INTENT: 50,
    TIME_WAITING_PER_10S: 1,
    RECENT_ACTIVITY: 10,
    RECENT_ACTIVITY_WINDOW_MS: 2 * 60 * 1000, // 2 minutes
    CONVERSATION_FATIGUE: -40,
    FATIGUE_WINDOW_DAYS: 7,
};

const MATCH_TIMEOUTS = {
    EXPAND_CRITERIA_MS: 60 * 1000,    // 60 seconds
    OFFER_ALTERNATIVE_MS: 2 * 60 * 1000, // 2 minutes
};

const MATCH_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes after ending

const VENT_AUTO_DELETE_OPTIONS = {
    '24h': 24 * 60 * 60 * 1000,
    '72h': 72 * 60 * 60 * 1000,
    'keep': null,
};

const WARNINGS_AUTO_REVIEW_THRESHOLD = 3;
const WARNINGS_REVIEW_WINDOW_DAYS = 30;

const SUBSCRIPTION_GRACE_DAYS = 3;

module.exports = {
    IDENTITY_MODES,
    PLAN_TYPES,
    PLATFORMS,
    REPORT_REASONS,
    MATCH_STATUS,
    REPORT_STATUS,
    MODERATOR_ROLES,
    SUSPENSION_DURATIONS,
    MATCH_SCORING,
    MATCH_TIMEOUTS,
    MATCH_COOLDOWN_MS,
    VENT_AUTO_DELETE_OPTIONS,
    WARNINGS_AUTO_REVIEW_THRESHOLD,
    WARNINGS_REVIEW_WINDOW_DAYS,
    SUBSCRIPTION_GRACE_DAYS,
};
