const { Pool } = require('pg');
const logger = require('../utils/logger');

// Database configuration
const dbConfig = {
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || '',
  host: process.env.DB_HOST || 'localhost',
  database: process.env.DB_NAME || 'pharmaflow',
  port: parseInt(process.env.DB_PORT) || 5432,
  
  // Connection pool settings
  max: parseInt(process.env.DB_POOL_MAX) || 20, // Maximum number of clients in pool
  min: parseInt(process.env.DB_POOL_MIN) || 2,  // Minimum number of clients in pool
  idle: parseInt(process.env.DB_POOL_IDLE) || 10000, // How long a client can be idle before closing
  acquire: parseInt(process.env.DB_POOL_ACQUIRE) || 30000, // Maximum time to get connection
  
  // Connection timeout
  connectionTimeoutMillis: parseInt(process.env.DB_CONNECTION_TIMEOUT) || 10000,
  
  // Query timeout
  query_timeout: parseInt(process.env.DB_QUERY_TIMEOUT) || 60000,
  
  // SSL settings (important for production)
  ssl: process.env.NODE_ENV === 'production' ? {
    rejectUnauthorized: false // Set to true in production with proper certificates
  } : false,

  // Application name for PostgreSQL logs
  application_name: 'PharmaFlow-API'
};

// Create connection pool
const pool = new Pool(dbConfig);

// Pool event handlers for monitoring
pool.on('connect', (client) => {
  logger.info(`New database connection established. Total connections: ${pool.totalCount}`);
});

pool.on('acquire', (client) => {
  logger.debug('Database connection acquired from pool');
});

pool.on('remove', (client) => {
  logger.info(`Database connection removed from pool. Remaining: ${pool.totalCount}`);
});

pool.on('error', (err, client) => {
  logger.error('Unexpected error on idle database client:', err);
});

// Database connection test function
const testConnection = async () => {
  try {
    const client = await pool.connect();
    const result = await client.query('SELECT NOW() as current_time, version() as version');
    client.release();
    
    logger.info('Database connection test successful:', {
      time: result.rows[0].current_time,
      version: result.rows[0].version.split(',')[0] // Just the PostgreSQL version part
    });
    
    return true;
  } catch (error) {
    logger.error('Database connection test failed:', error.message);
    throw error;
  }
};

// Initialize database extensions and verify schema
const initializeDatabase = async () => {
  const client = await pool.connect();
  
  try {
    // Verify required extensions are installed
    const extensionsQuery = `
      SELECT extname FROM pg_extension 
      WHERE extname IN ('uuid-ossp', 'pgcrypto')
    `;
    const extensions = await client.query(extensionsQuery);
    
    const installedExtensions = extensions.rows.map(row => row.extname);
    const requiredExtensions = ['uuid-ossp', 'pgcrypto'];
    
    for (const ext of requiredExtensions) {
      if (!installedExtensions.includes(ext)) {
        logger.warn(`Required extension '${ext}' not found. Make sure it's installed.`);
      }
    }
    
    // Verify key tables exist
    const tablesQuery = `
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      AND table_name IN ('users', 'products', 'inventory', 'sales', 'customers')
    `;
    const tables = await client.query(tablesQuery);
    
    if (tables.rows.length === 0) {
      logger.warn('Core database tables not found. Make sure schema is properly initialized.');
    } else {
      logger.info(`Found ${tables.rows.length} core tables in database`);
    }
    
    return true;
  } catch (error) {
    logger.error('Database initialization check failed:', error.message);
    throw error;
  } finally {
    client.release();
  }
};

// Graceful shutdown function
const closeDatabase = async () => {
  try {
    await pool.end();
    logger.info('Database pool has ended gracefully');
  } catch (error) {
    logger.error('Error closing database pool:', error.message);
  }
};

// Query helper function with error handling
const query = async (text, params = []) => {
  const start = Date.now();
  
  try {
    const result = await pool.query(text, params);
    const duration = Date.now() - start;
    
    // Log slow queries (over 1 second)
    if (duration > 1000) {
      logger.warn(`Slow query detected (${duration}ms):`, {
        query: text.substring(0, 100) + '...',
        params: params.length
      });
    }
    
    return result;
  } catch (error) {
    logger.error('Database query error:', {
      error: error.message,
      query: text.substring(0, 100) + '...',
      params: params.length
    });
    throw error;
  }
};

// Transaction helper function
const transaction = async (callback) => {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error('Transaction rolled back:', error.message);
    throw error;
  } finally {
    client.release();
  }
};

// Health check function for monitoring
const healthCheck = async () => {
  try {
    const result = await query('SELECT 1 as health_check');
    return {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      totalConnections: pool.totalCount,
      idleConnections: pool.idleCount,
      waitingConnections: pool.waitingCount
    };
  } catch (error) {
    return {
      status: 'unhealthy',
      error: error.message,
      timestamp: new Date().toISOString()
    };
  }
};

module.exports = {
  pool,
  query,
  transaction,
  testConnection,
  initializeDatabase,
  closeDatabase,
  healthCheck
};
