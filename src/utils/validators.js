/**
 * Validation helpers
 */

const validateEmail = (email) => {
    const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return re.test(email);
};

const validatePassword = (password) => {
    // Minimum 8 characters, at least one uppercase, one lowercase, one number
    const re = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)[a-zA-Z\d@$!%*?&]{8,}$/;
    return re.test(password);
};

const validatePhoneNumber = (phone) => {
    // E.164 format
    const re = /^\+[1-9]\d{1,14}$/;
    return re.test(phone);
};

const PASSWORD_REQUIREMENTS = 'Password must be at least 8 characters with uppercase, lowercase, and number.';

module.exports = {
    validateEmail,
    validatePassword,
    validatePhoneNumber,
    PASSWORD_REQUIREMENTS,
};
