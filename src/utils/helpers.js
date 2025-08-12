// src/utils/helpers.js
const crypto = require('crypto');

/**
 * Generate a random string of specified length
 * @param {number} length - Length of the random string
 * @returns {string} Random string
 */
const generateRandomString = (length = 32) => {
  return crypto.randomBytes(length).toString('hex');
};

/**
 * Paginate query results
 * @param {number} page - Page number
 * @param {number} limit - Items per page
 * @returns {Object} Pagination object with offset and limit
 */
const getPagination = (page = 1, limit = 20) => {
  const offset = (page - 1) * limit;
  return { offset: parseInt(offset), limit: parseInt(limit) };
};

/**
 * Format pagination response
 * @param {number} totalItems - Total number of items
 * @param {number} page - Current page
 * @param {number} limit - Items per page
 * @returns {Object} Pagination metadata
 */
const getPaginationMetadata = (totalItems, page, limit) => {
  const totalPages = Math.ceil(totalItems / limit);
  return {
    currentPage: parseInt(page),
    totalPages,
    totalItems: parseInt(totalItems),
    itemsPerPage: parseInt(limit),
    hasNextPage: page < totalPages,
    hasPrevPage: page > 1,
  };
};

/**
 * Sanitize object by removing null, undefined, and empty string values
 * @param {Object} obj - Object to sanitize
 * @returns {Object} Sanitized object
 */
const sanitizeObject = (obj) => {
  const sanitized = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== null && value !== undefined && value !== '') {
      sanitized[key] = value;
    }
  }
  return sanitized;
};

/**
 * Convert string to camelCase
 * @param {string} str - String to convert
 * @returns {string} CamelCase string
 */
const toCamelCase = (str) => {
  return str.replace(/_([a-z])/g, (match, letter) => letter.toUpperCase());
};

/**
 * Convert object keys from snake_case to camelCase
 * @param {Object} obj - Object to convert
 * @returns {Object} Object with camelCase keys
 */
const keysToCamelCase = (obj) => {
  if (Array.isArray(obj)) {
    return obj.map(keysToCamelCase);
  } else if (obj !== null && typeof obj === 'object') {
    const camelObj = {};
    for (const [key, value] of Object.entries(obj)) {
      camelObj[toCamelCase(key)] = keysToCamelCase(value);
    }
    return camelObj;
  }
  return obj;
};

/**
 * Validate email format
 * @param {string} email - Email to validate
 * @returns {boolean} True if valid email
 */
const isValidEmail = (email) => {
  const emailRegex = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
  return emailRegex.test(email);
};

/**
 * Generate slug from text
 * @param {string} text - Text to convert to slug
 * @returns {string} Slug
 */
const generateSlug = (text) => {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9 -]/g, '') // Remove invalid chars
    .replace(/\s+/g, '-') // Replace spaces with -
    .replace(/-+/g, '-') // Replace multiple - with single -
    .replace(/^-+/, '') // Trim - from start
    .replace(/-+$/, ''); // Trim - from end
};

module.exports = {
  generateRandomString,
  getPagination,
  getPaginationMetadata,
  sanitizeObject,
  toCamelCase,
  keysToCamelCase,
  isValidEmail,
  generateSlug,
};
