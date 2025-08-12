const bcrypt = require('bcrypt');
const { query, transaction } = require('../config/database');
const config = require('../config/environment');
const logger = require('../utils/logger');
const { validateEmail, validatePassword, generatePagination } = require('../utils/helpers');

class UserController {
  /**
   * Get all users with pagination and filtering
   */
  static async getAllUsers(req, res) {
    try {
      const { 
        page = 1, 
        limit = 10, 
        role, 
        isActive, 
        search,
        sortBy = 'created_at',
        sortOrder = 'DESC'
      } = req.query;

      // Validate pagination parameters
      const pageNum = Math.max(1, parseInt(page));
      const limitNum = Math.min(100, Math.max(1, parseInt(limit)));
      const offset = (pageNum - 1) * limitNum;

      // Validate sort parameters
      const allowedSortFields = ['username', 'email', 'first_name', 'last_name', 'role', 'created_at', 'last_login'];
      const sortField = allowedSortFields.includes(sortBy) ? sortBy : 'created_at';
      const sortDir = sortOrder.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

      // Build WHERE clause
      let whereClause = 'WHERE 1=1';
      const queryParams = [];
      let paramIndex = 1;

      if (role) {
        whereClause += ` AND role = $${paramIndex}`;
        queryParams.push(role);
        paramIndex++;
      }

      if (isActive !== undefined) {
        whereClause += ` AND is_active = $${paramIndex}`;
        queryParams.push(isActive === 'true');
        paramIndex++;
      }

      if (search) {
        whereClause += ` AND (
          username ILIKE $${paramIndex} OR 
          email ILIKE $${paramIndex} OR 
          first_name ILIKE $${paramIndex} OR 
          last_name ILIKE $${paramIndex}
        )`;
        queryParams.push(`%${search}%`);
        paramIndex++;
      }

      // Get total count
      const countQuery = `
        SELECT COUNT(*) as total 
        FROM users 
        ${whereClause}
      `;
      const countResult = await query(countQuery, queryParams);
      const totalUsers = parseInt(countResult.rows[0].total);

      // Get paginated users
      const usersQuery = `
        SELECT 
          user_id, username, email, first_name, last_name, role, phone, 
          is_active, last_login, created_at, updated_at
        FROM users 
        ${whereClause}
        ORDER BY ${sortField} ${sortDir}
        LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
      `;
      queryParams.push(limitNum, offset);

      const usersResult = await query(usersQuery, queryParams);

      const pagination = generatePagination(pageNum, limitNum, totalUsers);

      res.json({
        success: true,
        data: {
          users: usersResult.rows.map(user => ({
            id: user.user_id,
            username: user.username,
            email: user.email,
            firstName: user.first_name,
            lastName: user.last_name,
            role: user.role,
            phone: user.phone,
            isActive: user.is_active,
            lastLogin: user.last_login,
            createdAt: user.created_at,
            updatedAt: user.updated_at
          })),
          pagination
        }
      });

    } catch (error) {
      logger.error('Get all users error:', error.message);
      res.status(500).json({
        success: false,
        message: 'Failed to retrieve users'
      });
    }
  }

  /**
   * Get user by ID
   */
  static async getUserById(req, res) {
    try {
      const { userId } = req.params;

      if (!userId || isNaN(userId)) {
        return res.status(400).json({
          success: false,
          message: 'Valid user ID is required'
        });
      }

      const userQuery = `
        SELECT 
          user_id, username, email, first_name, last_name, role, phone, 
          is_active, last_login, created_at, updated_at
        FROM users 
        WHERE user_id = $1
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
            isActive: user.is_active,
            lastLogin: user.last_login,
            createdAt: user.created_at,
            updatedAt: user.updated_at
          }
        }
      });

    } catch (error) {
      logger.error('Get user by ID error:', error.message);
      res.status(500).json({
        success: false,
        message: 'Failed to retrieve user'
      });
    }
  }

  /**
   * Create new user (Admin only)
   */
  static async createUser(req, res) {
    try {
      const { 
        username, 
        email, 
        password, 
        firstName, 
        lastName, 
        role = 'technician',
        phone,
        isActive = true
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
          INSERT INTO users (username, email, password_hash, first_name, last_name, role, phone, is_active)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          RETURNING user_id, username, email, first_name, last_name, role, phone, is_active, created_at
        `;
        
        const result = await client.query(insertUserQuery, [
          username,
          email,
          passwordHash,
          firstName,
          lastName,
          role,
          phone,
          isActive
        ]);

        const newUser = result.rows[0];

        logger.info('New user created by admin', {
          createdUserId: newUser.user_id,
          createdUsername: newUser.username,
          createdBy: req.user.userId,
          createdByUsername: req.user.username
        });

        res.status(201).json({
          success: true,
          message: 'User created successfully',
          data: {
            user: {
              id: newUser.user_id,
              username: newUser.username,
              email: newUser.email,
              firstName: newUser.first_name,
              lastName: newUser.last_name,
              role: newUser.role,
              phone: newUser.phone,
              isActive: newUser.is_active,
              createdAt: newUser.created_at
            }
          }
        });
      });

    } catch (error) {
      logger.error('Create user error:', error.message);
      res.status(400).json({
        success: false,
        message: error.message || 'Failed to create user'
      });
    }
  }

  /**
   * Update user (Admin only)
   */
  static async updateUser(req, res) {
    try {
      const { userId } = req.params;
      const { 
        username, 
        email, 
        firstName, 
        lastName, 
        role, 
        phone, 
        isActive 
      } = req.body;

      if (!userId || isNaN(userId)) {
        return res.status(400).json({
          success: false,
          message: 'Valid user ID is required'
        });
      }

      // Validate email if provided
      if (email && !validateEmail(email)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid email format'
        });
      }

      // Validate role if provided
      if (role) {
        const validRoles = ['admin', 'pharmacist', 'technician', 'cashier', 'manager'];
        if (!validRoles.includes(role)) {
          return res.status(400).json({
            success: false,
            message: 'Invalid role specified'
          });
        }
      }

      await transaction(async (client) => {
        // Check if user exists
        const userExistsQuery = `SELECT user_id FROM users WHERE user_id = $1`;
        const userExists = await client.query(userExistsQuery, [userId]);

        if (userExists.rows.length === 0) {
          throw new Error('User not found');
        }

        // Check if username or email is already taken by another user
        if (username || email) {
          const conflictQuery = `
            SELECT user_id, username, email 
            FROM users 
            WHERE (username = $1 OR email = $2) AND user_id != $3
          `;
          const conflicts = await client.query(conflictQuery, [username, email, userId]);

          if (conflicts.rows.length > 0) {
            const conflict = conflicts.rows[0];
            const field = conflict.username === username ? 'username' : 'email';
            throw new Error(`${field} is already taken by another user`);
          }
        }

        // Build update query dynamically
        const updateFields = [];
        const updateValues = [];
        let paramIndex = 1;

        if (username !== undefined) {
          updateFields.push(`username = $${paramIndex}`);
          updateValues.push(username);
          paramIndex++;
        }

        if (email !== undefined) {
          updateFields.push(`email = $${paramIndex}`);
          updateValues.push(email);
          paramIndex++;
        }

        if (firstName !== undefined) {
          updateFields.push(`first_name = $${paramIndex}`);
          updateValues.push(firstName);
          paramIndex++;
        }

        if (lastName !== undefined) {
          updateFields.push(`last_name = $${paramIndex}`);
          updateValues.push(lastName);
          paramIndex++;
        }

        if (role !== undefined) {
          updateFields.push(`role = $${paramIndex}`);
          updateValues.push(role);
          paramIndex++;
        }

        if (phone !== undefined) {
          updateFields.push(`phone = $${paramIndex}`);
          updateValues.push(phone);
          paramIndex++;
        }

        if (isActive !== undefined) {
          updateFields.push(`is_active = $${paramIndex}`);
          updateValues.push(isActive);
          paramIndex++;
        }

        if (updateFields.length === 0) {
          throw new Error('No fields to update');
        }

        updateFields.push('updated_at = NOW()');
        updateValues.push(userId);

        const updateQuery = `
          UPDATE users 
          SET ${updateFields.join(', ')}
          WHERE user_id = $${paramIndex}
          RETURNING user_id, username, email, first_name, last_name, role, phone, is_active, updated_at
        `;

        const result = await client.query(updateQuery, updateValues);
        const updatedUser = result.rows[0];

        logger.info('User updated by admin', {
          updatedUserId: updatedUser.user_id,
          updatedUsername: updatedUser.username,
          updatedBy: req.user.userId,
          updatedByUsername: req.user.username
        });

        res.json({
          success: true,
          message: 'User updated successfully',
          data: {
            user: {
              id: updatedUser.user_id,
              username: updatedUser.username,
              email: updatedUser.email,
              firstName: updatedUser.first_name,
              lastName: updatedUser.last_name,
              role: updatedUser.role,
              phone: updatedUser.phone,
              isActive: updatedUser.is_active,
              updatedAt: updatedUser.updated_at
            }
          }
        });
      });

    } catch (error) {
      logger.error('Update user error:', error.message);
      res.status(400).json({
        success: false,
        message: error.message || 'Failed to update user'
      });
    }
  }

  /**
   * Delete user (soft delete - set is_active to false)
   */
  static async deleteUser(req, res) {
    try {
      const { userId } = req.params;

      if (!userId || isNaN(userId)) {
        return res.status(400).json({
          success: false,
          message: 'Valid user ID is required'
        });
      }

      // Prevent self-deletion
      if (parseInt(userId) === req.user.userId) {
        return res.status(400).json({
          success: false,
          message: 'Cannot delete your own account'
        });
      }

      const updateQuery = `
        UPDATE users 
        SET is_active = FALSE, updated_at = NOW()
        WHERE user_id = $1 AND is_active = TRUE
        RETURNING user_id, username, first_name, last_name
      `;

      const result = await query(updateQuery, [userId]);

      if (result.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'User not found or already deactivated'
        });
      }

      const deactivatedUser = result.rows[0];

      logger.info('User deactivated by admin', {
        deactivatedUserId: deactivatedUser.user_id,
        deactivatedUsername: deactivatedUser.username,
        deactivatedBy: req.user.userId,
        deactivatedByUsername: req.user.username
      });

      res.json({
        success: true,
        message: 'User deactivated successfully',
        data: {
          user: {
            id: deactivatedUser.user_id,
            username: deactivatedUser.username,
            firstName: deactivatedUser.first_name,
            lastName: deactivatedUser.last_name
          }
        }
      });

    } catch (error) {
      logger.error('Delete user error:', error.message);
      res.status(500).json({
        success: false,
        message: 'Failed to deactivate user'
      });
    }
  }

  /**
   * Reset user password (Admin only)
   */
  static async resetUserPassword(req, res) {
    try {
      const { userId } = req.params;
      const { newPassword, temporaryPassword = false } = req.body;

      if (!userId || isNaN(userId)) {
        return res.status(400).json({
          success: false,
          message: 'Valid user ID is required'
        });
      }

      if (!newPassword) {
        return res.status(400).json({
          success: false,
          message: 'New password is required'
        });
      }

      // Validate password strength
      const passwordValidation = validatePassword(newPassword);
      if (!passwordValidation.isValid) {
        return res.status(400).json({
          success: false,
          message: 'Password does not meet requirements',
          errors: passwordValidation.errors
        });
      }

      await transaction(async (client) => {
        // Check if user exists
        const userQuery = `
          SELECT user_id, username, first_name, last_name 
          FROM users 
          WHERE user_id = $1 AND is_active = TRUE
        `;
        const userResult = await client.query(userQuery, [userId]);

        if (userResult.rows.length === 0) {
          throw new Error('User not found or inactive');
        }

        const user = userResult.rows[0];

        // Hash new password
        const passwordHash = await bcrypt.hash(newPassword, config.security.bcryptRounds);

        // Update password
        const updateQuery = `
          UPDATE users 
          SET password_hash = $1, updated_at = NOW()
          WHERE user_id = $2
        `;
        await client.query(updateQuery, [passwordHash, userId]);

        logger.info('Password reset by admin', {
          targetUserId: user.user_id,
          targetUsername: user.username,
          resetBy: req.user.userId,
          resetByUsername: req.user.username,
          temporaryPassword: temporaryPassword
        });

        res.json({
          success: true,
          message: `Password reset successfully${temporaryPassword ? ' (temporary password)' : ''}`,
          data: {
            user: {
              id: user.user_id,
              username: user.username,
              firstName: user.first_name,
              lastName: user.last_name
            },
            temporaryPassword: temporaryPassword
          }
        });
      });

    } catch (error) {
      logger.error('Reset password error:', error.message);
      res.status(400).json({
        success: false,
        message: error.message || 'Failed to reset password'
      });
    }
  }

  /**
   * Get user statistics (Admin only)
   */
  static async getUserStats(req, res) {
    try {
      const statsQuery = `
        SELECT 
          COUNT(*) as total_users,
          COUNT(*) FILTER (WHERE is_active = TRUE) as active_users,
          COUNT(*) FILTER (WHERE is_active = FALSE) as inactive_users,
          COUNT(*) FILTER (WHERE role = 'admin') as admin_count,
          COUNT(*) FILTER (WHERE role = 'pharmacist') as pharmacist_count,
          COUNT(*) FILTER (WHERE role = 'technician') as technician_count,
          COUNT(*) FILTER (WHERE role = 'cashier') as cashier_count,
          COUNT(*) FILTER (WHERE role = 'manager') as manager_count,
          COUNT(*) FILTER (WHERE last_login >= NOW() - INTERVAL '7 days') as recent_logins,
          COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days') as recent_registrations
        FROM users
      `;

      const result = await query(statsQuery);
      const stats = result.rows[0];

      res.json({
        success: true,
        data: {
          stats: {
            totalUsers: parseInt(stats.total_users),
            activeUsers: parseInt(stats.active_users),
            inactiveUsers: parseInt(stats.inactive_users),
            roleDistribution: {
              admin: parseInt(stats.admin_count),
              pharmacist: parseInt(stats.pharmacist_count),
              technician: parseInt(stats.technician_count),
              cashier: parseInt(stats.cashier_count),
              manager: parseInt(stats.manager_count)
            },
            recentLogins: parseInt(stats.recent_logins),
            recentRegistrations: parseInt(stats.recent_registrations)
          }
        }
      });

    } catch (error) {
      logger.error('Get user stats error:', error.message);
      res.status(500).json({
        success: false,
        message: 'Failed to retrieve user statistics'
      });
    }
  }

  /**
   * Toggle user status (activate/deactivate)
   */
  static async toggleUserStatus(req, res) {
    try {
      const { userId } = req.params;

      if (!userId || isNaN(userId)) {
        return res.status(400).json({
          success: false,
          message: 'Valid user ID is required'
        });
      }

      // Prevent self-deactivation
      if (parseInt(userId) === req.user.userId) {
        return res.status(400).json({
          success: false,
          message: 'Cannot change your own account status'
        });
      }

      const toggleQuery = `
        UPDATE users 
        SET is_active = NOT is_active, updated_at = NOW()
        WHERE user_id = $1
        RETURNING user_id, username, first_name, last_name, is_active
      `;

      const result = await query(toggleQuery, [userId]);

      if (result.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'User not found'
        });
      }

      const user = result.rows[0];

      logger.info('User status toggled by admin', {
        targetUserId: user.user_id,
        targetUsername: user.username,
        newStatus: user.is_active ? 'active' : 'inactive',
        changedBy: req.user.userId,
        changedByUsername: req.user.username
      });

      res.json({
        success: true,
        message: `User ${user.is_active ? 'activated' : 'deactivated'} successfully`,
        data: {
          user: {
            id: user.user_id,
            username: user.username,
            firstName: user.first_name,
            lastName: user.last_name,
            isActive: user.is_active
          }
        }
      });

    } catch (error) {
      logger.error('Toggle user status error:', error.message);
      res.status(500).json({
        success: false,
        message: 'Failed to toggle user status'
      });
    }
  }
}

module.exports = UserController;
