module.exports = {
  // User Roles
  USER_ROLES: {
    ADMIN: 'admin',
    PHARMACIST: 'pharmacist',
    TECHNICIAN: 'technician',
    CASHIER: 'cashier',
    MANAGER: 'manager',
  },

  // Payment Methods
  PAYMENT_METHODS: {
    CASH: 'cash',
    CARD: 'card',
    INSURANCE: 'insurance',
    CHECK: 'check',
    DIGITAL: 'digital',
  },

  // Inventory Status
  INVENTORY_STATUS: {
    ACTIVE: 'active',
    EXPIRED: 'expired',
    DAMAGED: 'damaged',
    RECALLED: 'recalled',
  },

  // Stock Movement Types
  MOVEMENT_TYPES: {
    PURCHASE: 'purchase',
    SALE: 'sale',
    ADJUSTMENT: 'adjustment',
    RETURN: 'return',
    EXPIRED: 'expired',
    DAMAGED: 'damaged',
    TRANSFER: 'transfer',
  },

  // Alert Types
  ALERT_TYPES: {
    THIRTY_DAYS: '30_days',
    SIXTY_DAYS: '60_days',
    NINETY_DAYS: '90_days',
    EXPIRED: 'expired',
  },

  // HTTP Status Codes
  HTTP_STATUS: {
    OK: 200,
    CREATED: 201,
    NO_CONTENT: 204,
    BAD_REQUEST: 400,
    UNAUTHORIZED: 401,
    FORBIDDEN: 403,
    NOT_FOUND: 404,
    CONFLICT: 409,
    UNPROCESSABLE_ENTITY: 422,
    INTERNAL_SERVER_ERROR: 500,
  },

  // Pagination
  PAGINATION: {
    DEFAULT_PAGE: 1,
    DEFAULT_LIMIT: 20,
    MAX_LIMIT: 100,
  },

  // Validation
  VALIDATION: {
    PASSWORD_MIN_LENGTH: 8,
    PHONE_REGEX: /^[\+]?[1-9][\d]{0,15}$/,
    EMAIL_REGEX: /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/,
  },
};
