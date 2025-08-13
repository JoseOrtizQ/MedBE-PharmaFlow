const { pool, query, transaction } = require('../config/database');
const { validationResult } = require('express-validator');

class AlertController {
  // Get all alerts with filtering and pagination
  async getAllAlerts(req, res) {
    try {
      const {
        page = 1,
        limit = 50,
        alert_type,
        is_acknowledged,
        date_from,
        date_to,
        search,
        sort_by = 'alert_date',
        sort_order = 'DESC'
      } = req.query;

      const offset = (page - 1) * limit;
      let whereConditions = [];
      let params = [];
      let paramCount = 0;

      if (alert_type) {
        paramCount++;
        whereConditions.push(`ea.alert_type = $${paramCount}`);
        params.push(alert_type);
      }

      if (is_acknowledged !== undefined) {
        paramCount++;
        whereConditions.push(`ea.is_acknowledged = $${paramCount}`);
        params.push(is_acknowledged === 'true');
      }

      if (date_from) {
        paramCount++;
        whereConditions.push(`ea.alert_date >= $${paramCount}`);
        params.push(date_from);
      }

      if (date_to) {
        paramCount++;
        whereConditions.push(`ea.alert_date <= $${paramCount}`);
        params.push(date_to);
      }

      if (search) {
        paramCount++;
        whereConditions.push(`(
          p.product_name ILIKE $${paramCount} OR 
          p.product_code ILIKE $${paramCount} OR
          ea.batch_number ILIKE $${paramCount}
        )`);
        params.push(`%${search}%`);
      }

      const whereClause = whereConditions.length > 0 ? 'WHERE ' + whereConditions.join(' AND ') : '';
      
      // Validate sort parameters
      const validSortColumns = ['alert_date', 'expiration_date', 'alert_type', 'quantity', 'product_name'];
      const validSortOrder = ['ASC', 'DESC'];
      const safeSortBy = validSortColumns.includes(sort_by) ? sort_by : 'alert_date';
      const safeSortOrder = validSortOrder.includes(sort_order.toUpperCase()) ? sort_order.toUpperCase() : 'DESC';

      const sortColumn = safeSortBy === 'product_name' ? 'p.product_name' : `ea.${safeSortBy}`;

      const alertsQuery = `
        SELECT 
          ea.*,
          p.product_code,
          p.product_name,
          p.brand_name,
          p.unit_cost,
          c.category_name,
          u.first_name || ' ' || u.last_name as acknowledged_by_name,
          (ea.expiration_date - CURRENT_DATE) as days_to_expiry,
          CASE 
            WHEN ea.expiration_date < CURRENT_DATE THEN 'Expired'
            WHEN (ea.expiration_date - CURRENT_DATE) <= 30 THEN 'Critical'
            WHEN (ea.expiration_date - CURRENT_DATE) <= 60 THEN 'Warning'
            ELSE 'Watch'
          END as urgency_level,
          (ea.quantity * p.unit_cost) as value_at_risk
        FROM expiration_alerts ea
        JOIN products p ON ea.product_id = p.product_id
        LEFT JOIN categories c ON p.category_id = c.category_id
        LEFT JOIN users u ON ea.acknowledged_by = u.user_id
        ${whereClause}
        ORDER BY ${sortColumn} ${safeSortOrder}
        LIMIT $${paramCount + 1} OFFSET $${paramCount + 2}
      `;

      params.push(limit, offset);

      const result = await query(alertsQuery, params);

      // Get total count for pagination
      const countQuery = `
        SELECT COUNT(*) as total
        FROM expiration_alerts ea
        JOIN products p ON ea.product_id = p.product_id
        ${whereClause}
      `;

      const countParams = params.slice(0, -2); // Remove limit and offset
      const countResult = await query(countQuery, countParams);
      const totalRecords = parseInt(countResult.rows[0].total);

      res.json({
        success: true,
        data: result.rows,
        pagination: {
          currentPage: parseInt(page),
          totalPages: Math.ceil(totalRecords / limit),
          totalRecords,
          hasNext: (page * limit) < totalRecords,
          hasPrev: page > 1
        }
      });
    } catch (error) {
      console.error('Error fetching alerts:', error);
      res.status(500).json({
        success: false,
        message: 'Error fetching alerts',
        error: error.message
      });
    }
  }

  // Get alert by ID
  async getAlertById(req, res) {
    try {
      const { id } = req.params;

      const alertQuery = `
        SELECT 
          ea.*,
          p.product_code,
          p.product_name,
          p.brand_name,
          p.generic_name,
          p.unit_cost,
          p.selling_price,
          c.category_name,
          i.location,
          i.lot_number,
          u.first_name || ' ' || u.last_name as acknowledged_by_name,
          (ea.expiration_date - CURRENT_DATE) as days_to_expiry,
          CASE 
            WHEN ea.expiration_date < CURRENT_DATE THEN 'Expired'
            WHEN (ea.expiration_date - CURRENT_DATE) <= 30 THEN 'Critical'
            WHEN (ea.expiration_date - CURRENT_DATE) <= 60 THEN 'Warning'
            ELSE 'Watch'
          END as urgency_level,
          (ea.quantity * p.unit_cost) as value_at_risk
        FROM expiration_alerts ea
        JOIN products p ON ea.product_id = p.product_id
        LEFT JOIN categories c ON p.category_id = c.category_id
        LEFT JOIN inventory i ON ea.inventory_id = i.inventory_id
        LEFT JOIN users u ON ea.acknowledged_by = u.user_id
        WHERE ea.alert_id = $1
      `;

      const result = await query(alertQuery, [id]);

      if (result.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'Alert not found'
        });
      }

      res.json({
        success: true,
        data: result.rows[0]
      });
    } catch (error) {
      console.error('Error fetching alert:', error);
      res.status(500).json({
        success: false,
        message: 'Error fetching alert',
        error: error.message
      });
    }
  }

  // Acknowledge alert
  async acknowledgeAlert(req, res) {
    try {
      const { id } = req.params;
      const { action_taken } = req.body;
      const acknowledged_by = req.user?.user_id;

      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          message: 'Validation errors',
          errors: errors.array()
        });
      }

      // Check if alert exists and is not already acknowledged
      const alertCheck = await query(
        'SELECT alert_id, is_acknowledged FROM expiration_alerts WHERE alert_id = $1',
        [id]
      );

      if (alertCheck.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'Alert not found'
        });
      }

      if (alertCheck.rows[0].is_acknowledged) {
        return res.status(400).json({
          success: false,
          message: 'Alert has already been acknowledged'
        });
      }

      const updateQuery = `
        UPDATE expiration_alerts 
        SET 
          is_acknowledged = true,
          acknowledged_by = $1,
          acknowledged_at = NOW(),
          action_taken = $2
        WHERE alert_id = $3
        RETURNING *
      `;

      const result = await query(updateQuery, [acknowledged_by, action_taken, id]);

      res.json({
        success: true,
        message: 'Alert acknowledged successfully',
        data: result.rows[0]
      });
    } catch (error) {
      console.error('Error acknowledging alert:', error);
      res.status(500).json({
        success: false,
        message: 'Error acknowledging alert',
        error: error.message
      });
    }
  }

  // Bulk acknowledge alerts
  async bulkAcknowledgeAlerts(req, res) {
    try {
      const { alert_ids, action_taken } = req.body;
      const acknowledged_by = req.user?.user_id;

      if (!alert_ids || !Array.isArray(alert_ids) || alert_ids.length === 0) {
        return res.status(400).json({
          success: false,
          message: 'Alert IDs array is required'
        });
      }

      const result = await transaction(async (client) => {
        const updateQuery = `
          UPDATE expiration_alerts 
          SET 
            is_acknowledged = true,
            acknowledged_by = $1,
            acknowledged_at = NOW(),
            action_taken = $2
          WHERE alert_id = ANY($3::int[]) AND is_acknowledged = false
          RETURNING *
        `;

        const updateResult = await client.query(updateQuery, [
          acknowledged_by,
          action_taken,
          alert_ids
        ]);

        return updateResult.rows;
      });

      res.json({
        success: true,
        message: `${result.length} alerts acknowledged successfully`,
        data: result
      });
    } catch (error) {
      console.error('Error bulk acknowledging alerts:', error);
      res.status(500).json({
        success: false,
        message: 'Error bulk acknowledging alerts',
        error: error.message
      });
    }
  }

  // Get critical alerts (expiring within 30 days or already expired)
  async getCriticalAlerts(req, res) {
    try {
      const { limit = 20 } = req.query;

      const criticalAlertsQuery = `
        SELECT 
          ea.*,
          p.product_code,
          p.product_name,
          p.brand_name,
          c.category_name,
          (ea.expiration_date - CURRENT_DATE) as days_to_expiry,
          (ea.quantity * p.unit_cost) as value_at_risk,
          CASE 
            WHEN ea.expiration_date < CURRENT_DATE THEN 'Expired'
            ELSE 'Critical'
          END as urgency_level
        FROM expiration_alerts ea
        JOIN products p ON ea.product_id = p.product_id
        LEFT JOIN categories c ON p.category_id = c.category_id
        WHERE ea.alert_type IN ('30_days', 'expired') 
          AND ea.is_acknowledged = false
          AND ea.quantity > 0
        ORDER BY 
          CASE WHEN ea.expiration_date < CURRENT_DATE THEN 1 ELSE 2 END,
          ea.expiration_date ASC
        LIMIT $1
      `;

      const result = await query(criticalAlertsQuery, [limit]);

      res.json({
        success: true,
        data: result.rows
      });
    } catch (error) {
      console.error('Error fetching critical alerts:', error);
      res.status(500).json({
        success: false,
        message: 'Error fetching critical alerts',
        error: error.message
      });
    }
  }

  // Get low stock alerts
  async getLowStockAlerts(req, res) {
    try {
      const { limit = 20 } = req.query;

      const lowStockQuery = `
        SELECT 
          p.product_id,
          p.product_code,
          p.product_name,
          p.brand_name,
          c.category_name,
          p.minimum_stock_level,
          p.reorder_point,
          COALESCE(SUM(i.quantity_available), 0) as current_stock,
          p.minimum_stock_level - COALESCE(SUM(i.quantity_available), 0) as shortage_quantity,
          CASE 
            WHEN COALESCE(SUM(i.quantity_available), 0) <= 0 THEN 'Out of Stock'
            WHEN COALESCE(SUM(i.quantity_available), 0) <= p.minimum_stock_level THEN 'Low Stock'
            WHEN COALESCE(SUM(i.quantity_available), 0) <= p.reorder_point THEN 'Reorder Point'
            ELSE 'Normal'
          END as stock_status,
          MAX(i.expiration_date) as next_expiry_date
        FROM products p
        LEFT JOIN inventory i ON i.product_id = p.product_id AND i.status = 'active'
        LEFT JOIN categories c ON p.category_id = c.category_id
        WHERE p.is_active = true
        GROUP BY p.product_id, p.product_code, p.product_name, p.brand_name, 
                 c.category_name, p.minimum_stock_level, p.reorder_point
        HAVING COALESCE(SUM(i.quantity_available), 0) <= p.minimum_stock_level
        ORDER BY shortage_quantity DESC
        LIMIT $1
      `;

      const result = await query(lowStockQuery, [limit]);

      res.json({
        success: true,
        data: result.rows
      });
    } catch (error) {
      console.error('Error fetching low stock alerts:', error);
      res.status(500).json({
        success: false,
        message: 'Error fetching low stock alerts',
        error: error.message
      });
    }
  }

  // Get alert statistics
  async getAlertStats(req, res) {
    try {
      const statsQuery = `
        SELECT 
          COUNT(*) as total_alerts,
          COUNT(*) FILTER (WHERE is_acknowledged = false) as unacknowledged_alerts,
          COUNT(*) FILTER (WHERE alert_type = 'expired') as expired_alerts,
          COUNT(*) FILTER (WHERE alert_type = '30_days') as critical_alerts,
          COUNT(*) FILTER (WHERE alert_type = '60_days') as warning_alerts,
          COUNT(*) FILTER (WHERE alert_type = '90_days') as watch_alerts,
          COALESCE(SUM(quantity * 
            (SELECT unit_cost FROM products WHERE product_id = expiration_alerts.product_id)
          ) FILTER (WHERE alert_type = 'expired' AND is_acknowledged = false), 0) as expired_value,
          COALESCE(SUM(quantity * 
            (SELECT unit_cost FROM products WHERE product_id = expiration_alerts.product_id)
          ) FILTER (WHERE is_acknowledged = false), 0) as total_value_at_risk
        FROM expiration_alerts
        WHERE alert_date >= CURRENT_DATE - INTERVAL '30 days'
      `;

      const alertStats = await query(statsQuery);

      // Get low stock statistics
      const lowStockQuery = `
        SELECT 
          COUNT(*) as total_low_stock_products,
          COUNT(*) FILTER (WHERE COALESCE(SUM(i.quantity_available), 0) <= 0) as out_of_stock_products,
          COUNT(*) FILTER (WHERE COALESCE(SUM(i.quantity_available), 0) <= p.minimum_stock_level AND COALESCE(SUM(i.quantity_available), 0) > 0) as low_stock_products,
          COUNT(*) FILTER (WHERE COALESCE(SUM(i.quantity_available), 0) <= p.reorder_point AND COALESCE(SUM(i.quantity_available), 0) > p.minimum_stock_level) as reorder_point_products
        FROM products p
        LEFT JOIN inventory i ON i.product_id = p.product_id AND i.status = 'active'
        WHERE p.is_active = true
        GROUP BY p.product_id, p.minimum_stock_level, p.reorder_point
        HAVING COALESCE(SUM(i.quantity_available), 0) <= p.reorder_point
      `;

      const lowStockStats = await query(lowStockQuery);

      const combinedStats = {
        expiration_alerts: alertStats.rows[0],
        stock_alerts: lowStockStats.rows.length > 0 ? {
          total_low_stock_products: lowStockStats.rows.length,
          out_of_stock_products: lowStockStats.rows.filter(row => parseInt(row.out_of_stock_products) > 0).length,
          low_stock_products: lowStockStats.rows.filter(row => parseInt(row.low_stock_products) > 0).length,
          reorder_point_products: lowStockStats.rows.filter(row => parseInt(row.reorder_point_products) > 0).length
        } : {
          total_low_stock_products: 0,
          out_of_stock_products: 0,
          low_stock_products: 0,
          reorder_point_products: 0
        }
      };

      res.json({
        success: true,
        data: combinedStats
      });
    } catch (error) {
      console.error('Error fetching alert statistics:', error);
      res.status(500).json({
        success: false,
        message: 'Error fetching alert statistics',
        error: error.message
      });
    }
  }

  // Generate expiration alerts manually (for testing or manual runs)
  async generateExpirationAlerts(req, res) {
    try {
      const result = await transaction(async (client) => {
        // Get inventory items that need alerts but don't have them yet
        const inventoryQuery = `
          SELECT DISTINCT
            i.inventory_id,
            i.product_id,
            i.batch_number,
            i.expiration_date,
            i.quantity_on_hand,
            CASE 
              WHEN i.expiration_date < CURRENT_DATE THEN 'expired'
              WHEN i.expiration_date <= CURRENT_DATE + INTERVAL '30 days' THEN '30_days'
              WHEN i.expiration_date <= CURRENT_DATE + INTERVAL '60 days' THEN '60_days'
              WHEN i.expiration_date <= CURRENT_DATE + INTERVAL '90 days' THEN '90_days'
            END as alert_type
          FROM inventory i
          WHERE i.status = 'active' 
            AND i.quantity_on_hand > 0
            AND i.expiration_date IS NOT NULL
            AND i.expiration_date <= CURRENT_DATE + INTERVAL '90 days'
            AND NOT EXISTS (
              SELECT 1 FROM expiration_alerts ea 
              WHERE ea.inventory_id = i.inventory_id 
                AND ea.expiration_date = i.expiration_date
                AND ea.alert_type = CASE 
                  WHEN i.expiration_date < CURRENT_DATE THEN 'expired'::alert_type
                  WHEN i.expiration_date <= CURRENT_DATE + INTERVAL '30 days' THEN '30_days'::alert_type
                  WHEN i.expiration_date <= CURRENT_DATE + INTERVAL '60 days' THEN '60_days'::alert_type
                  WHEN i.expiration_date <= CURRENT_DATE + INTERVAL '90 days' THEN '90_days'::alert_type
                END
            )
        `;

        const inventoryItems = await client.query(inventoryQuery);
        let alertsCreated = 0;

        for (const item of inventoryItems.rows) {
          if (item.alert_type) {
            const insertAlertQuery = `
              INSERT INTO expiration_alerts (
                inventory_id, 
                product_id, 
                batch_number, 
                expiration_date, 
                quantity, 
                alert_type, 
                alert_date
              ) VALUES ($1, $2, $3, $4, $5, $6, CURRENT_DATE)
            `;

            await client.query(insertAlertQuery, [
              item.inventory_id,
              item.product_id,
              item.batch_number,
              item.expiration_date,
              item.quantity_on_hand,
              item.alert_type
            ]);

            alertsCreated++;
          }
        }

        return alertsCreated;
      });

      res.json({
        success: true,
        message: `Generated ${result} new expiration alerts`,
        alerts_created: result
      });
    } catch (error) {
      console.error('Error generating expiration alerts:', error);
      res.status(500).json({
        success: false,
        message: 'Error generating expiration alerts',
        error: error.message
      });
    }
  }

  // Delete old acknowledged alerts (cleanup)
  async cleanupAlerts(req, res) {
    try {
      const { days_old = 90 } = req.query;

      const deleteQuery = `
        DELETE FROM expiration_alerts 
        WHERE is_acknowledged = true 
          AND acknowledged_at < CURRENT_DATE - INTERVAL '${parseInt(days_old)} days'
        RETURNING COUNT(*)
      `;

      const result = await query(deleteQuery);
      const deletedCount = result.rowCount || 0;

      res.json({
        success: true,
        message: `Cleaned up ${deletedCount} old acknowledged alerts`,
        deleted_count: deletedCount
      });
    } catch (error) {
      console.error('Error cleaning up alerts:', error);
      res.status(500).json({
        success: false,
        message: 'Error cleaning up alerts',
        error: error.message
      });
    }
  }

  // Get alerts by category
  async getAlertsByCategory(req, res) {
    try {
      const { category_id } = req.params;
      const { is_acknowledged = 'false', limit = 50 } = req.query;

      const alertsQuery = `
        SELECT 
          ea.*,
          p.product_code,
          p.product_name,
          p.brand_name,
          (ea.expiration_date - CURRENT_DATE) as days_to_expiry,
          (ea.quantity * p.unit_cost) as value_at_risk
        FROM expiration_alerts ea
        JOIN products p ON ea.product_id = p.product_id
        WHERE p.category_id = $1
          AND ea.is_acknowledged = $2
        ORDER BY ea.expiration_date ASC
        LIMIT $3
      `;

      const result = await query(alertsQuery, [category_id, is_acknowledged === 'true', limit]);

      res.json({
        success: true,
        data: result.rows
      });
    } catch (error) {
      console.error('Error fetching alerts by category:', error);
      res.status(500).json({
        success: false,
        message: 'Error fetching alerts by category',
        error: error.message
      });
    }
  }
}

module.exports = new AlertController();
