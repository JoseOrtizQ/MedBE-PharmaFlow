const { query, transaction } = require('../config/database');
const config = require('../config/environment');
const logger = require('../utils/logger');
const { generatePagination } = require('../utils/helpers');

class NotificationController {
  /**
   * Get user notifications with pagination and filtering
   */
  static async getUserNotifications(req, res) {
    try {
      const userId = req.user.userId;
      const { 
        page = 1, 
        limit = 20, 
        type,
        isRead,
        priority,
        sortBy = 'created_at',
        sortOrder = 'DESC'
      } = req.query;

      // Validate pagination parameters
      const pageNum = Math.max(1, parseInt(page));
      const limitNum = Math.min(100, Math.max(1, parseInt(limit)));
      const offset = (pageNum - 1) * limitNum;

      // Build WHERE clause for notifications
      let whereClause = 'WHERE (n.user_id = $1 OR n.user_id IS NULL)';
      const queryParams = [userId];
      let paramIndex = 2;

      if (type) {
        whereClause += ` AND n.notification_type = $${paramIndex}`;
        queryParams.push(type);
        paramIndex++;
      }

      if (isRead !== undefined) {
        whereClause += ` AND n.is_read = $${paramIndex}`;
        queryParams.push(isRead === 'true');
        paramIndex++;
      }

      if (priority) {
        whereClause += ` AND n.priority = $${paramIndex}`;
        queryParams.push(priority);
        paramIndex++;
      }

      // Validate sort parameters
      const allowedSortFields = ['created_at', 'priority', 'notification_type'];
      const sortField = allowedSortFields.includes(sortBy) ? sortBy : 'created_at';
      const sortDir = sortOrder.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

      // Get total count
      const countQuery = `
        SELECT COUNT(*) as total 
        FROM notifications n
        ${whereClause}
      `;
      const countResult = await query(countQuery, queryParams);
      const totalNotifications = parseInt(countResult.rows[0].total);

      // Get notifications
      const notificationsQuery = `
        SELECT 
          n.notification_id,
          n.notification_type,
          n.title,
          n.message,
          n.priority,
          n.is_read,
          n.read_at,
          n.data,
          n.expires_at,
          n.created_at,
          n.updated_at,
          u.first_name || ' ' || u.last_name as created_by_name
        FROM notifications n
        LEFT JOIN users u ON n.created_by = u.user_id
        ${whereClause}
        ORDER BY 
          CASE WHEN n.priority = 'high' THEN 1 
               WHEN n.priority = 'medium' THEN 2 
               ELSE 3 END,
          n.${sortField} ${sortDir}
        LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
      `;
      queryParams.push(limitNum, offset);

      const notificationsResult = await query(notificationsQuery, queryParams);

      const pagination = generatePagination(pageNum, limitNum, totalNotifications);

      res.json({
        success: true,
        data: {
          notifications: notificationsResult.rows.map(notification => ({
            id: notification.notification_id,
            type: notification.notification_type,
            title: notification.title,
            message: notification.message,
            priority: notification.priority,
            isRead: notification.is_read,
            readAt: notification.read_at,
            data: notification.data,
            expiresAt: notification.expires_at,
            createdAt: notification.created_at,
            updatedAt: notification.updated_at,
            createdBy: notification.created_by_name
          })),
          pagination,
          unreadCount: notificationsResult.rows.filter(n => !n.is_read).length
        }
      });

    } catch (error) {
      logger.error('Get user notifications error:', error.message);
      res.status(500).json({
        success: false,
        message: 'Failed to retrieve notifications'
      });
    }
  }

  /**
   * Mark notification as read
   */
  static async markAsRead(req, res) {
    try {
      const { notificationId } = req.params;
      const userId = req.user.userId;

      if (!notificationId || isNaN(notificationId)) {
        return res.status(400).json({
          success: false,
          message: 'Valid notification ID is required'
        });
      }

      await transaction(async (client) => {
        // Check if notification exists and belongs to user or is global
        const notificationQuery = `
          SELECT notification_id, is_read, user_id
          FROM notifications 
          WHERE notification_id = $1 AND (user_id = $2 OR user_id IS NULL)
        `;
        const notificationResult = await client.query(notificationQuery, [notificationId, userId]);

        if (notificationResult.rows.length === 0) {
          throw new Error('Notification not found');
        }

        const notification = notificationResult.rows[0];

        if (notification.is_read) {
          return res.json({
            success: true,
            message: 'Notification already marked as read'
          });
        }

        // Mark as read
        const updateQuery = `
          UPDATE notifications 
          SET is_read = TRUE, read_at = NOW(), updated_at = NOW()
          WHERE notification_id = $1
          RETURNING notification_id, read_at
        `;
        const updateResult = await client.query(updateQuery, [notificationId]);

        logger.info('Notification marked as read', {
          notificationId: parseInt(notificationId),
          userId: userId
        });

        res.json({
          success: true,
          message: 'Notification marked as read',
          data: {
            notificationId: parseInt(notificationId),
            readAt: updateResult.rows[0].read_at
          }
        });
      });

    } catch (error) {
      logger.error('Mark notification as read error:', error.message);
      res.status(400).json({
        success: false,
        message: error.message || 'Failed to mark notification as read'
      });
    }
  }

  /**
   * Mark all notifications as read for user
   */
  static async markAllAsRead(req, res) {
    try {
      const userId = req.user.userId;
      const { type } = req.query;

      let whereClause = 'WHERE (user_id = $1 OR user_id IS NULL) AND is_read = FALSE';
      const queryParams = [userId];
      let paramIndex = 2;

      if (type) {
        whereClause += ` AND notification_type = $${paramIndex}`;
        queryParams.push(type);
        paramIndex++;
      }

      const updateQuery = `
        UPDATE notifications 
        SET is_read = TRUE, read_at = NOW(), updated_at = NOW()
        ${whereClause}
        RETURNING notification_id
      `;

      const result = await query(updateQuery, queryParams);
      const markedCount = result.rows.length;

      logger.info('Bulk mark notifications as read', {
        userId: userId,
        count: markedCount,
        type: type || 'all'
      });

      res.json({
        success: true,
        message: `${markedCount} notifications marked as read`,
        data: {
          markedCount: markedCount
        }
      });

    } catch (error) {
      logger.error('Mark all notifications as read error:', error.message);
      res.status(500).json({
        success: false,
        message: 'Failed to mark notifications as read'
      });
    }
  }

  /**
   * Get notification statistics
   */
  static async getNotificationStats(req, res) {
    try {
      const userId = req.user.userId;

      const statsQuery = `
        SELECT 
          COUNT(*) as total_notifications,
          COUNT(CASE WHEN is_read = FALSE THEN 1 END) as unread_count,
          COUNT(CASE WHEN notification_type = 'expiration_alert' AND is_read = FALSE THEN 1 END) as unread_expiration,
          COUNT(CASE WHEN notification_type = 'low_stock_alert' AND is_read = FALSE THEN 1 END) as unread_low_stock,
          COUNT(CASE WHEN notification_type = 'system_alert' AND is_read = FALSE THEN 1 END) as unread_system,
          COUNT(CASE WHEN priority = 'high' AND is_read = FALSE THEN 1 END) as high_priority_unread,
          COUNT(CASE WHEN created_at >= NOW() - INTERVAL '24 hours' THEN 1 END) as today_notifications
        FROM notifications 
        WHERE user_id = $1 OR user_id IS NULL
      `;

      const result = await query(statsQuery, [userId]);
      const stats = result.rows[0];

      res.json({
        success: true,
        data: {
          total: parseInt(stats.total_notifications),
          unread: parseInt(stats.unread_count),
          byType: {
            expiration: parseInt(stats.unread_expiration),
            lowStock: parseInt(stats.unread_low_stock),
            system: parseInt(stats.unread_system)
          },
          highPriorityUnread: parseInt(stats.high_priority_unread),
          todayCount: parseInt(stats.today_notifications)
        }
      });

    } catch (error) {
      logger.error('Get notification stats error:', error.message);
      res.status(500).json({
        success: false,
        message: 'Failed to retrieve notification statistics'
      });
    }
  }

  /**
   * Create system notification (admin only)
   */
  static async createSystemNotification(req, res) {
    try {
      const {
        title,
        message,
        priority = 'medium',
        notificationType = 'system_alert',
        targetUserId,
        data,
        expiresAt
      } = req.body;

      // Input validation
      if (!title || !message) {
        return res.status(400).json({
          success: false,
          message: 'Title and message are required'
        });
      }

      const validPriorities = ['low', 'medium', 'high'];
      if (!validPriorities.includes(priority)) {
        return res.status(400).json({
          success: false,
          message: 'Priority must be low, medium, or high'
        });
      }

      await transaction(async (client) => {
        // If targetUserId is specified, verify user exists
        if (targetUserId) {
          const userQuery = `SELECT user_id FROM users WHERE user_id = $1 AND is_active = TRUE`;
          const userResult = await client.query(userQuery, [targetUserId]);
          
          if (userResult.rows.length === 0) {
            throw new Error('Target user not found or inactive');
          }
        }

        // Create notification
        const insertQuery = `
          INSERT INTO notifications (
            notification_type, title, message, priority, user_id, 
            data, expires_at, created_by
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          RETURNING notification_id, created_at
        `;

        const result = await client.query(insertQuery, [
          notificationType,
          title,
          message,
          priority,
          targetUserId || null,
          data ? JSON.stringify(data) : null,
          expiresAt || null,
          req.user.userId
        ]);

        const newNotification = result.rows[0];

        logger.info('System notification created', {
          notificationId: newNotification.notification_id,
          type: notificationType,
          priority: priority,
          targetUser: targetUserId || 'all',
          createdBy: req.user.userId
        });

        res.status(201).json({
          success: true,
          message: 'System notification created successfully',
          data: {
            notificationId: newNotification.notification_id,
            createdAt: newNotification.created_at
          }
        });
      });

    } catch (error) {
      logger.error('Create system notification error:', error.message);
      res.status(400).json({
        success: false,
        message: error.message || 'Failed to create system notification'
      });
    }
  }

  /**
   * Generate expiration alerts
   */
  static async generateExpirationAlerts(req, res) {
    try {
      const { force = false } = req.query;

      await transaction(async (client) => {
        // Get expiring products that haven't been notified recently
        const expiringQuery = `
          SELECT DISTINCT
            ep.product_id,
            ep.product_code,
            ep.product_name,
            ep.inventory_id,
            ep.batch_number,
            ep.quantity_on_hand,
            ep.expiration_date,
            ep.days_to_expiry,
            ep.urgency_level,
            ep.value_at_risk
          FROM expiring_products ep
          LEFT JOIN notifications n ON 
            n.notification_type = 'expiration_alert' AND 
            n.data::jsonb->>'product_id' = ep.product_id::text AND
            n.data::jsonb->>'batch_number' = ep.batch_number AND
            n.created_at > NOW() - INTERVAL '24 hours'
          WHERE n.notification_id IS NULL OR $1 = true
        `;

        const expiringResult = await client.query(expiringQuery, [force]);
        let createdCount = 0;

        for (const product of expiringResult.rows) {
          // Determine priority based on urgency level
          let priority = 'medium';
          if (product.urgency_level === 'Expired' || product.urgency_level === 'Critical') {
            priority = 'high';
          } else if (product.urgency_level === 'Warning') {
            priority = 'medium';
          } else {
            priority = 'low';
          }

          const title = product.urgency_level === 'Expired' 
            ? `Product Expired: ${product.product_name}`
            : `Product Expiring Soon: ${product.product_name}`;

          const message = product.urgency_level === 'Expired'
            ? `${product.product_name} (Batch: ${product.batch_number}) has expired. Quantity: ${product.quantity_on_hand} units.`
            : `${product.product_name} (Batch: ${product.batch_number}) expires in ${product.days_to_expiry} days. Quantity: ${product.quantity_on_hand} units.`;

          // Create notification
          const insertNotificationQuery = `
            INSERT INTO notifications (
              notification_type, title, message, priority, 
              data, created_by
            )
            VALUES ($1, $2, $3, $4, $5, $6)
          `;

          await client.query(insertNotificationQuery, [
            'expiration_alert',
            title,
            message,
            priority,
            JSON.stringify({
              product_id: product.product_id,
              product_code: product.product_code,
              inventory_id: product.inventory_id,
              batch_number: product.batch_number,
              expiration_date: product.expiration_date,
              quantity: product.quantity_on_hand,
              urgency_level: product.urgency_level,
              value_at_risk: product.value_at_risk
            }),
            req.user.userId
          ]);

          createdCount++;
        }

        logger.info('Expiration alerts generated', {
          count: createdCount,
          generatedBy: req.user.userId
        });

        res.json({
          success: true,
          message: `${createdCount} expiration alerts generated`,
          data: {
            alertsGenerated: createdCount,
            productsChecked: expiringResult.rows.length
          }
        });
      });

    } catch (error) {
      logger.error('Generate expiration alerts error:', error.message);
      res.status(500).json({
        success: false,
        message: 'Failed to generate expiration alerts'
      });
    }
  }

  /**
   * Generate low stock alerts
   */
  static async generateLowStockAlerts(req, res) {
    try {
      const { force = false } = req.query;

      await transaction(async (client) => {
        // Get low stock products that haven't been notified recently
        const lowStockQuery = `
          SELECT DISTINCT
            lsp.product_id,
            lsp.product_code,
            lsp.product_name,
            lsp.brand_name,
            lsp.available_quantity,
            lsp.minimum_stock_level,
            lsp.shortage_quantity
          FROM low_stock_products lsp
          LEFT JOIN notifications n ON 
            n.notification_type = 'low_stock_alert' AND 
            n.data::jsonb->>'product_id' = lsp.product_id::text AND
            n.created_at > NOW() - INTERVAL '24 hours'
          WHERE n.notification_id IS NULL OR $1 = true
        `;

        const lowStockResult = await client.query(lowStockQuery, [force]);
        let createdCount = 0;

        for (const product of lowStockResult.rows) {
          // Determine priority based on shortage severity
          let priority = 'medium';
          if (product.available_quantity === 0) {
            priority = 'high'; // Out of stock
          } else if (product.shortage_quantity >= product.minimum_stock_level) {
            priority = 'high'; // Severely low
          }

          const title = product.available_quantity === 0
            ? `Out of Stock: ${product.product_name}`
            : `Low Stock Alert: ${product.product_name}`;

          const message = product.available_quantity === 0
            ? `${product.product_name} is completely out of stock. Minimum required: ${product.minimum_stock_level} units.`
            : `${product.product_name} is running low. Current: ${product.available_quantity} units, Minimum: ${product.minimum_stock_level} units.`;

          // Create notification
          const insertNotificationQuery = `
            INSERT INTO notifications (
              notification_type, title, message, priority, 
              data, created_by
            )
            VALUES ($1, $2, $3, $4, $5, $6)
          `;

          await client.query(insertNotificationQuery, [
            'low_stock_alert',
            title,
            message,
            priority,
            JSON.stringify({
              product_id: product.product_id,
              product_code: product.product_code,
              product_name: product.product_name,
              brand_name: product.brand_name,
              available_quantity: product.available_quantity,
              minimum_stock_level: product.minimum_stock_level,
              shortage_quantity: product.shortage_quantity
            }),
            req.user.userId
          ]);

          createdCount++;
        }

        logger.info('Low stock alerts generated', {
          count: createdCount,
          generatedBy: req.user.userId
        });

        res.json({
          success: true,
          message: `${createdCount} low stock alerts generated`,
          data: {
            alertsGenerated: createdCount,
            productsChecked: lowStockResult.rows.length
          }
        });
      });

    } catch (error) {
      logger.error('Generate low stock alerts error:', error.message);
      res.status(500).json({
        success: false,
        message: 'Failed to generate low stock alerts'
      });
    }
  }

  /**
   * Send broadcast notification to all users
   */
  static async sendBroadcast(req, res) {
    try {
      const {
        title,
        message,
        priority = 'medium',
        expiresAt,
        targetRoles
      } = req.body;

      if (!title || !message) {
        return res.status(400).json({
          success: false,
          message: 'Title and message are required'
        });
      }

      await transaction(async (client) => {
        let recipients = [];

        if (targetRoles && targetRoles.length > 0) {
          // Get users with specific roles
          const rolesQuery = `
            SELECT user_id FROM users 
            WHERE role = ANY($1) AND is_active = TRUE
          `;
          const rolesResult = await client.query(rolesQuery, [targetRoles]);
          recipients = rolesResult.rows.map(row => row.user_id);
        } else {
          // Get all active users
          const allUsersQuery = `SELECT user_id FROM users WHERE is_active = TRUE`;
          const allUsersResult = await client.query(allUsersQuery);
          recipients = allUsersResult.rows.map(row => row.user_id);
        }

        let createdCount = 0;

        // Create notification for each recipient
        for (const userId of recipients) {
          const insertQuery = `
            INSERT INTO notifications (
              notification_type, title, message, priority, 
              user_id, expires_at, created_by
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7)
          `;

          await client.query(insertQuery, [
            'broadcast',
            title,
            message,
            priority,
            userId,
            expiresAt || null,
            req.user.userId
          ]);

          createdCount++;
        }

        logger.info('Broadcast notification sent', {
          recipientCount: createdCount,
          targetRoles: targetRoles || 'all',
          sentBy: req.user.userId
        });

        res.json({
          success: true,
          message: `Broadcast sent to ${createdCount} users`,
          data: {
            recipientCount: createdCount,
            targetRoles: targetRoles || ['all']
          }
        });
      });

    } catch (error) {
      logger.error('Send broadcast error:', error.message);
      res.status(500).json({
        success: false,
        message: 'Failed to send broadcast notification'
      });
    }
  }

  /**
   * Delete notification (admin only)
   */
  static async deleteNotification(req, res) {
    try {
      const { notificationId } = req.params;

      if (!notificationId || isNaN(notificationId)) {
        return res.status(400).json({
          success: false,
          message: 'Valid notification ID is required'
        });
      }

      const deleteQuery = `
        DELETE FROM notifications 
        WHERE notification_id = $1
        RETURNING notification_id, notification_type, title
      `;

      const result = await query(deleteQuery, [notificationId]);

      if (result.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'Notification not found'
        });
      }

      const deletedNotification = result.rows[0];

      logger.info('Notification deleted', {
        notificationId: parseInt(notificationId),
        type: deletedNotification.notification_type,
        deletedBy: req.user.userId
      });

      res.json({
        success: true,
        message: 'Notification deleted successfully',
        data: {
          notificationId: parseInt(notificationId)
        }
      });

    } catch (error) {
      logger.error('Delete notification error:', error.message);
      res.status(500).json({
        success: false,
        message: 'Failed to delete notification'
      });
    }
  }

  /**
   * Clean up expired notifications
   */
  static async cleanupExpiredNotifications(req, res) {
    try {
      const cleanupQuery = `
        DELETE FROM notifications 
        WHERE expires_at IS NOT NULL AND expires_at < NOW()
        RETURNING notification_id, notification_type
      `;

      const result = await query(cleanupQuery);
      const deletedCount = result.rows.length;

      logger.info('Expired notifications cleaned up', {
        count: deletedCount,
        cleanedBy: req.user.userId
      });

      res.json({
        success: true,
        message: `${deletedCount} expired notifications cleaned up`,
        data: {
          deletedCount: deletedCount
        }
      });

    } catch (error) {
      logger.error('Cleanup expired notifications error:', error.message);
      res.status(500).json({
        success: false,
        message: 'Failed to cleanup expired notifications'
      });
    }
  }
}

module.exports = NotificationController;
