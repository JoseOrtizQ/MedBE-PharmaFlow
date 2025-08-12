// tests/setup.js
const { pool } = require('../src/config/database');

// Global test setup
beforeAll(async () => {
  // Setup test database connection
  console.log('Setting up test environment...');
});

// Global test teardown
afterAll(async () => {
  // Close database connection
  await pool.end();
  console.log('Test environment cleaned up.');
});

// Optional: Reset database before each test suite
beforeEach(async () => {
  // You might want to clear test data here
});
