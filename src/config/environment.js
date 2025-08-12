const logger = require('../utils/logger');

// Load environment variables from .env file
require('dotenv').config();

// Environment detection
const NODE_ENV = process.env.NODE_ENV || 'development';
const isDevelopment = NODE_ENV === 'development';
const isProduction = NODE_ENV === 'production';
const isTest = NODE_ENV === 'test';

// Required environment variables
const requiredEnvVars = [
  'JWT_SECRET',
  'DB_NAME',
  'DB_USER'
];

// Optional environment variables with defaults
const optionalEnvVars = {
  PORT: 3000,
  HOST: '0.0.0.0',
  JWT_EXPIRES_IN: '24h',
  JWT_REFRESH_EXPIRES_IN: '7d',
  BCRYPT_ROUNDS: 12,
  API_RATE_LIMIT_WINDOW: 900000, // 15 minutes
  API_RATE_LIMIT_MAX_REQUESTS: 100,
  MAX_FILE_SIZE: 5242880, // 5MB
  EXPIRATION_WARNING_DAYS: 90,
  LOW_STOCK_THRESHOLD_PERCENTAGE: 20,
  CRITICAL_STOCK_THRESHOLD: 5
};

// Validate required environment variables
const validateEnvironment = () => {
  const missingVars = [];
  
  requiredEnvVars.forEach(varName => {
    if (!process.env[varName]) {
      missingVars.push(varName);
    }
  });

  if (missingVars.length > 0) {
    const errorMsg = `Missing required environment variables: ${missingVars.join(', ')}`;
    logger.error(errorMsg);
    throw new Error(errorMsg);
  }

  // Production-specific required variables
  if (isProduction) {
    const productionRequiredVars = [
      'DB_PASSWORD',
      'EMAIL_HOST',
      'EMAIL_USER',
      'EMAIL_PASS'
    ];
    
    const missingProdVars = [];
    productionRequiredVars.forEach(varName => {
      if (!process.env[varName]) {
        missingProdVars.push(varName);
      }
    });

    if (missingProdVars.length > 0) {
      const errorMsg = `Missing required production environment variables: ${missingProdVars.join(', ')}`;
      logger.error(errorMsg);
      throw new Error(errorMsg);
    }
  }
};

// Get environment variable with default fallback
const getEnvVar = (name, defaultValue = null) => {
  return process.env[name] || optionalEnvVars[name] || defaultValue;
};

// Parse boolean environment variables
const parseBoolean = (value, defaultValue = false) => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    return value.toLowerCase() === 'true' || value === '1';
  }
  return defaultValue;
};

// Parse integer environment variables
const parseInt = (value, defaultValue = 0) => {
  const parsed = Number.parseInt(value, 10);
  return isNaN(parsed) ? defaultValue : parsed;
};

// Application configuration object
const config = {
  // Environment
  NODE_ENV,
  isDevelopment,
  isProduction,
  isTest,

  // Server Configuration
  server: {
    port: parseInt(getEnvVar('PORT')),
    host: getEnvVar('HOST'),
    baseUrl: getEnvVar('BASE_URL', isDevelopment ? 'http://localhost:3000' : ''),
    apiPrefix: getEnvVar('API_PREFIX', '/api/v1'),
    trustProxy: parseBoolean(getEnvVar('TRUST_PROXY'), isProduction)
  },

  // Database Configuration (validation only, actual config in database.js)
  database: {
    name: process.env.DB_NAME,
    user: process.env.DB_USER,
    host: getEnvVar('DB_HOST', 'localhost'),
    port: parseInt(getEnvVar('DB_PORT', 5432))
  },

  // JWT Configuration
  jwt: {
    secret: process.env.JWT_SECRET,
    expiresIn: getEnvVar('JWT_EXPIRES_IN'),
    refreshSecret: getEnvVar('JWT_REFRESH_SECRET', process.env.JWT_SECRET + '_refresh'),
    refreshExpiresIn: getEnvVar('JWT_REFRESH_EXPIRES_IN'),
    algorithm: 'HS256',
    issuer: 'pharmaflow-api'
  },

  // Security Configuration
  security: {
    bcryptRounds: parseInt(getEnvVar('BCRYPT_ROUNDS')),
    passwordMinLength: parseInt(getEnvVar('PASSWORD_MIN_LENGTH', 8)),
    passwordRequireSpecialChars: parseBoolean(getEnvVar('PASSWORD_REQUIRE_SPECIAL', true)),
    maxLoginAttempts: parseInt(getEnvVar('MAX_LOGIN_ATTEMPTS', 5)),
    lockoutDuration: parseInt(getEnvVar('LOCKOUT_DURATION', 1800000)), // 30 minutes
    sessionTimeout: parseInt(getEnvVar('SESSION_TIMEOUT', 3600000)) // 1 hour
  },

  // CORS Configuration
  cors: {
    origin: getEnvVar('CORS_ORIGIN', isDevelopment ? '*' : false),
    credentials: parseBoolean(getEnvVar('CORS_CREDENTIALS', true)),
    optionsSuccessStatus: 200,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key']
  },

  // Rate Limiting Configuration
  rateLimit: {
    windowMs: parseInt(getEnvVar('API_RATE_LIMIT_WINDOW')),
    maxRequests: parseInt(getEnvVar('API_RATE_LIMIT_MAX_REQUESTS')),
    message: 'Too many requests from this IP, please try again later',
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: parseBoolean(getEnvVar('RATE_LIMIT_SKIP_SUCCESS', false))
  },

  // File Upload Configuration
  fileUpload: {
    maxFileSize: parseInt(getEnvVar('MAX_FILE_SIZE')),
    allowedTypes: getEnvVar('ALLOWED_FILE_TYPES', 'image/jpeg,image/png,image/gif,application/pdf').split(','),
    uploadDir: getEnvVar('UPLOAD_DIR', './uploads'),
    tempDir: getEnvVar('TEMP_DIR', './temp')
  },

  // Pharmacy Business Configuration
  pharmacy: {
    // Stock management
    expirationWarningDays: parseInt(getEnvVar('EXPIRATION_WARNING_DAYS')),
    lowStockThresholdPercentage: parseInt(getEnvVar('LOW_STOCK_THRESHOLD_PERCENTAGE')),
    criticalStockThreshold: parseInt(getEnvVar('CRITICAL_STOCK_THRESHOLD')),
    autoReorderEnabled: parseBoolean(getEnvVar('AUTO_REORDER_ENABLED', false)),
    
    // Alerts and notifications
    alertCheckInterval: parseInt(getEnvVar('ALERT_CHECK_INTERVAL', 3600000)), // 1 hour
    batchExpirationAlerts: parseBoolean(getEnvVar('BATCH_EXPIRATION_ALERTS', true)),
    lowStockAlerts: parseBoolean(getEnvVar('LOW_STOCK_ALERTS', true)),
    
    // Controlled substances
    controlledSubstanceLogging: parseBoolean(getEnvVar('CONTROLLED_SUBSTANCE_LOGGING', true)),
    requirePrescriptionValidation: parseBoolean(getEnvVar('REQUIRE_PRESCRIPTION_VALIDATION', true)),
    
    // Pricing and tax
    defaultTaxRate: parseFloat(getEnvVar('DEFAULT_TAX_RATE', '0.00')),
    defaultMarkupPercentage: parseFloat(getEnvVar('DEFAULT_MARKUP_PERCENTAGE', '25.00'))
  },

  // Email Configuration
  email: {
    enabled: parseBoolean(getEnvVar('EMAIL_ENABLED', !isDevelopment)),
    host: getEnvVar('EMAIL_HOST'),
    port: parseInt(getEnvVar('EMAIL_PORT', 587)),
    secure: parseBoolean(getEnvVar('EMAIL_SECURE', false)),
    user: getEnvVar('EMAIL_USER'),
    password: getEnvVar('EMAIL_PASS'),
    from: getEnvVar('EMAIL_FROM', 'noreply@pharmaflow.com'),
    
    // Email templates
    templates: {
      lowStockAlert: 'low-stock-alert',
      expirationAlert: 'expiration-alert',
      orderConfirmation: 'order-confirmation',
      passwordReset: 'password-reset'
    }
  },

  // External API Configuration
  externalApis: {
    // Payment processing
    stripe: {
      publicKey: getEnvVar('STRIPE_PUBLIC_KEY'),
      secretKey: getEnvVar('STRIPE_SECRET_KEY'),
      webhookSecret: getEnvVar('STRIPE_WEBHOOK_SECRET')
    },
    
    // Insurance verification (example)
    insuranceApi: {
      enabled: parseBoolean(getEnvVar('INSURANCE_API_ENABLED', false)),
      baseUrl: getEnvVar('INSURANCE_API_URL'),
      apiKey: getEnvVar('INSURANCE_API_KEY'),
      timeout: parseInt(getEnvVar('INSURANCE_API_TIMEOUT', 30000))
    },
    
    // Supplier APIs
    supplierApi: {
      enabled: parseBoolean(getEnvVar('SUPPLIER_API_ENABLED', false)),
      timeout: parseInt(getEnvVar('SUPPLIER_API_TIMEOUT', 30000))
    }
  },

  // Logging Configuration
  logging: {
    level: getEnvVar('LOG_LEVEL', isDevelopment ? 'debug' : 'info'),
    enableConsole: parseBoolean(getEnvVar('LOG_ENABLE_CONSOLE', isDevelopment)),
    enableFile: parseBoolean(getEnvVar('LOG_ENABLE_FILE', isProduction)),
    logDir: getEnvVar('LOG_DIR', './logs'),
    maxFiles: parseInt(getEnvVar('LOG_MAX_FILES', 14)),
    maxSize: getEnvVar('LOG_MAX_SIZE', '20m')
  },

  // Monitoring and Health Checks
  monitoring: {
    enabled: parseBoolean(getEnvVar('MONITORING_ENABLED', isProduction)),
    healthCheckPath: getEnvVar('HEALTH_CHECK_PATH', '/health'),
    metricsPath: getEnvVar('METRICS_PATH', '/metrics'),
    
    // External monitoring services
    sentry: {
      dsn: getEnvVar('SENTRY_DSN'),
      enabled: parseBoolean(getEnvVar('SENTRY_ENABLED', isProduction))
    }
  },

  // Cache Configuration
  cache: {
    enabled: parseBoolean(getEnvVar('CACHE_ENABLED', true)),
    type: getEnvVar('CACHE_TYPE', 'memory'), // memory, redis
    ttl: parseInt(getEnvVar('CACHE_TTL', 300)), // 5 minutes
    
    // Redis configuration (if using Redis cache)
    redis: {
      host: getEnvVar('REDIS_HOST', 'localhost'),
      port: parseInt(getEnvVar('REDIS_PORT', 6379)),
      password: getEnvVar('REDIS_PASSWORD'),
      db: parseInt(getEnvVar('REDIS_DB', 0))
    }
  },

  // Swagger/API Documentation
  swagger: {
    enabled: parseBoolean(getEnvVar('SWAGGER_ENABLED', !isProduction)),
    path: getEnvVar('SWAGGER_PATH', '/api-docs'),
    title: 'PharmaFlow API',
    version: getEnvVar('API_VERSION', '1.0.0'),
    description: 'Healthcare Inventory Management System API'
  }
};

// Validate environment on module load
try {
  validateEnvironment();
  logger.info('Environment configuration validated successfully', {
    environment: NODE_ENV,
    server: `${config.server.host}:${config.server.port}`,
    database: config.database.name
  });
} catch (error) {
  logger.error('Environment validation failed:', error.message);
  process.exit(1);
}

module.exports = config;
