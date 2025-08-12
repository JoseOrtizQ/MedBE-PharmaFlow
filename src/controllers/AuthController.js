const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { query, transaction } = require('../config/database');
const config = require('../config/environment');
const logger = require('../utils/logger');
const { validateEmail, validatePassword } = require('../utils/helpers');

class AuthController {
  /**
   * Register a new user
   */
  static async register(req, res) {
    try {
      const { 
        username, 
        email, 
        password, 
        confirmPassword,
        firstName, 
        lastName, 
        role = 'technician',
        phone 
      } = req.body;

      // Input validation
      if (!username || !email || !password || !firstName || !lastName) {
        return res.status(400).json({
          success: false,
          message: 'Missing required fields',
          errors: {
            required: ['username', 'email', 'password', 'firstName', 'lastName']
          }
        });
      }

      // Password confirmation check
      if (password !== confirmPassword) {
        return res.status(400).json({
          success: false,
          message: 'Passwords do not match'
        });
      }

      // Validate email format
      if (!validateEmail(email)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid email format'
        });
      }

      // Validate password strength
      const passwordValidation = validatePassword(password);
      if (!passwordValidation.isValid) {
        return res.status(400).json({
          success: false,
          message: 'Password does not meet requirements',
          errors: passwordValidation.errors
        });
      }

      // Validate role
      const validRoles = ['admin', 'pharmacist', 'technician', 'cashier', 'manager'];
      if (!validRoles.includes(role)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid role specified'
        });
      }

      await transaction(async (client) => {
        // Check if username or email already exists
        const existingUserQuery = `
          SELECT user_id, username, email 
          FROM users 
          WHERE username = $1 OR email = $2
        `;
        const existingUser = await client.query(existingUserQuery, [username, email]);

        if (existingUser.rows.length > 0) {
          const existing = existingUser.rows[0];
          const field = existing.username === username ? 'username' : 'email';
          throw new Error(`User with this ${field} already exists`);
        }

        // Hash password
        const passwordHash = await bcrypt.hash(password, config.security.bcryptRounds);

        // Insert new user
        const insertUserQuery = `
          INSERT INTO users (username, email, password_hash, first_name, last_name, role, phone)
          VALUES ($1, $2, $3, $4, $5, $6, $7)
          RETURNING user_id, username, email, first_name, last_name, role, phone, created_at
        `;
        
        const result = await client.query(insertUserQuery, [
          username,
          email,
          passwordHash,
          firstName,
          lastName,
          role,
          phone
        ]);

        const newUser = result.rows[0];

        logger.info('New user registered', {
          userId: newUser.user_id,
          username: newUser.username,
          role: newUser.role
        });

        // Generate JWT token
        const token = jwt.sign(
          { 
            userId: newUser.user_id,
            username: newUser.username,
            role: newUser.role 
          },
          config.jwt.secret,
          { 
            expiresIn: config.jwt.expiresIn,
            issuer: config.jwt.issuer 
          }
        );

        res.status(201).json({
          success: true,
          message: 'User registered successfully',
          data: {
            user: {
              id: newUser.user_id,
              username: newUser.username,
              email: newUser.email,
              firstName: newUser.first_name,
              lastName: newUser.last_name,
              role: newUser.role,
              phone: newUser.phone,
              createdAt: newUser.created_at
            },
            token
          }
        });
      });

    } catch (error) {
      logger.error('Registration error:', error.message);
      res.status(400).json({
        success: false,
        message: error.message || 'Registration failed'
      });
    }
  }

  /**
   * Login user
   */
  static async login(req, res) {
    try {
      const { username, password } = req.body;

      if (!username || !password) {
        return res.status(400).json({
          success: false,
          message: 'Username and password are required'
        });
      }

      // Find user by username or email
      const userQuery = `
        SELECT user_id, username, email, password_hash, first_name, last_name, role, is_active, last_login
        FROM users 
        WHERE (username = $1 OR email = $1) AND is_active = TRUE
      `;
      
      const userResult = await query(userQuery, [username]);

      if (userResult.rows.length === 0) {
        return res.status(401).json({
          success: false,
          message: 'Invalid credentials'
        });
      }

      const user = userResult.rows[0];

      // Verify password
      const isPasswordValid = await bcrypt.compare(password, user.password_hash);

      if (!isPasswordValid) {
        logger.warn('Failed login attempt', {
          username: user.username,
          ip: req.ip
        });

        return res.status(401).json({
          success: false,
          message: 'Invalid credentials'
        });
      }

      // Update last login timestamp
      const updateLoginQuery = `
        UPDATE users 
        SET last_login = NOW() 
        WHERE user_id = $1
      `;
      await query(updateLoginQuery, [user.user_id]);

      // Generate JWT token
      const token = jwt.sign(
        { 
          userId: user.user_id,
          username: user.username,
          role: user.role 
        },
        config.jwt.secret,
        { 
          expiresIn: config.jwt.expiresIn,
          issuer: config.jwt.issuer 
        }
      );

      logger.info('User logged in successfully', {
        userId: user.user_id,
        username: user.username,
        role: user.role
      });

      res.json({
        success: true,
        message: 'Login successful',
        data: {
          user: {
            id: user.user_id,
            username: user.username,
            email: user.email,
            firstName: user.first_name,
            lastName: user.last_name,
            role: user.role,
            lastLogin: user.last_login
          },
          token
        }
      });

    } catch (error) {
      logger.error('Login error:', error.message);
      res.status(500).json({
        success: false,
        message: 'Login failed'
      });
    }
  }

  /**
   * Get current user profile
   */
  static async getProfile(req, res) {
    try {
      const userId = req.user.userId;

      const userQuery = `
        SELECT user_id, username, email, first_name, last_name, role, phone, last_login, created_at, updated_at
        FROM users 
        WHERE user_id = $1 AND is_active = TRUE
      `;
      
      const result = await query(userQuery, [userId]);

      if (result.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'User not found'
        });
      }

      const user = result.rows[0];

      res.json({
        success: true,
        data: {
          user: {
            id: user.user_id,
            username: user.username,
            email: user.email,
            firstName: user.first_name,
            lastName: user.last_name,
            role: user.role,
            phone: user.phone,
            lastLogin: user.last_login,
            createdAt: user.created_at,
            updatedAt: user.updated_at
          }
        }
      });

    } catch (error) {
      logger.error('Get profile error:', error.message);
      res.status(500).json({
        success: false,
        message: 'Failed to retrieve profile'
      });
    }
  }

  /**
   * Update user profile
   */
  static async updateProfile(req, res) {
    try {
      const userId = req.user.userId;
      const { firstName, lastName, email, phone } = req.body;

      // Validate email if provided
      if (email && !validateEmail(email)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid email format'
        });
      }

      await transaction(async (client) => {
        // Check if email is already taken by another user
        if (email) {
          const emailCheckQuery = `
            SELECT user_id FROM users 
            WHERE email = $1 AND user_id != $2
          `;
          const emailCheck = await client.query(emailCheckQuery, [email, userId]);

          if (emailCheck.rows.length > 0) {
            throw new Error('Email is already taken by another user');
          }
        }

        // Update user profile
        const updateQuery = `
          UPDATE users 
          SET 
            first_name = COALESCE($1, first_name),
            last_name = COALESCE($2, last_name),
            email = COALESCE($3, email),
            phone = COALESCE($4, phone),
            updated_at = NOW()
          WHERE user_id = $5 AND is_active = TRUE
          RETURNING user_id, username, email, first_name, last_name, role, phone, updated_at
        `;

        const result = await client.query(updateQuery, [
          firstName, lastName, email, phone, userId
        ]);

        if (result.rows.length === 0) {
          throw new Error('User not found or inactive');
        }

        const updatedUser = result.rows[0];

        logger.info('User profile updated', {
          userId: updatedUser.user_id,
          username: updatedUser.username
        });

        res.json({
          success: true,
          message: 'Profile updated successfully',
          data: {
            user: {
              id: updatedUser.user_id,
              username: updatedUser.username,
              email: updatedUser.email,
              firstName: updatedUser.first_name,
              lastName: updatedUser.last_name,
              role: updatedUser.role,
              phone: updatedUser.phone,
              updatedAt: updatedUser.updated_at
            }
          }
        });
      });

    } catch (error) {
      logger.error('Update profile error:', error.message);
      res.status(400).json({
        success: false,
        message: error.message || 'Failed to update profile'
      });
    }
  }

  /**
   * Change password
   */
  static async changePassword(req, res) {
    try {
      const userId = req.user.userId;
      const { currentPassword, newPassword, confirmPassword } = req.body;

      if (!currentPassword || !newPassword || !confirmPassword) {
        return res.status(400).json({
          success: false,
          message: 'All password fields are required'
        });
      }

      if (newPassword !== confirmPassword) {
        return res.status(400).json({
          success: false,
          message: 'New passwords do not match'
        });
      }

      // Validate new password strength
      const passwordValidation = validatePassword(newPassword);
      if (!passwordValidation.isValid) {
        return res.status(400).json({
          success: false,
          message: 'New password does not meet requirements',
          errors: passwordValidation.errors
        });
      }

      await transaction(async (client) => {
        // Get current password hash
        const userQuery = `
          SELECT password_hash FROM users 
          WHERE user_id = $1 AND is_active = TRUE
        `;
        const userResult = await client.query(userQuery, [userId]);

        if (userResult.rows.length === 0) {
          throw new Error('User not found');
        }

        const user = userResult.rows[0];

        // Verify current password
        const isCurrentPasswordValid = await bcrypt.compare(currentPassword, user.password_hash);

        if (!isCurrentPasswordValid) {
          throw new Error('Current password is incorrect');
        }

        // Hash new password
        const newPasswordHash = await bcrypt.hash(newPassword, config.security.bcryptRounds);

        // Update password
        const updateQuery = `
          UPDATE users 
          SET password_hash = $1, updated_at = NOW()
          WHERE user_id = $2
        `;
        await client.query(updateQuery, [newPasswordHash, userId]);

        logger.info('Password changed successfully', {
          userId: userId,
          username: req.user.username
        });

        res.json({
          success: true,
          message: 'Password changed successfully'
        });
      });

    } catch (error) {
      logger.error('Change password error:', error.message);
      res.status(400).json({
        success: false,
        message: error.message || 'Failed to change password'
      });
    }
  }

  /**
   * Logout user (mainly for token blacklisting if implemented)
   */
  static async logout(req, res) {
    try {
      // In a stateless JWT system, logout is handled client-side
      // But we can log the logout event for audit purposes
      logger.info('User logged out', {
        userId: req.user.userId,
        username: req.user.username
      });

      res.json({
        success: true,
        message: 'Logged out successfully'
      });

    } catch (error) {
      logger.error('Logout error:', error.message);
      res.status(500).json({
        success: false,
        message: 'Logout failed'
      });
    }
  }

  /**
   * Verify token (for middleware or client-side verification)
   */
  static async verifyToken(req, res) {
    try {
      // If we reach here, the token is valid (checked by auth middleware)
      res.json({
        success: true,
        message: 'Token is valid',
        data: {
          user: {
            id: req.user.userId,
            username: req.user.username,
            role: req.user.role
          }
        }
      });

    } catch (error) {
      logger.error('Token verification error:', error.message);
      res.status(500).json({
        success: false,
        message: 'Token verification failed'
      });
    }
  }
}

module.exports = AuthController;
