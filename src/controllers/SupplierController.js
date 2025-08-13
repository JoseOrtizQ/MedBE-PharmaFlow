const { pool, query, transaction } = require('../config/database');
const { validationResult } = require('express-validator');

class SupplierController {
  // Get all suppliers with filtering and pagination
  async getAllSuppliers(req, res) {
    try {
      const {
        page = 1,
        limit = 50,
        search,
        is_active,
        country,
        sort_by = 'supplier_name',
        sort_order = 'ASC'
      } = req.query;

      const offset = (page - 1) * limit;
      let whereConditions = [];
      let params = [];
      let paramCount = 0;

      if (search) {
        paramCount++;
        whereConditions.push(`(
          supplier_name ILIKE $${paramCount} OR 
          contact_person ILIKE $${paramCount} OR 
          email ILIKE $${paramCount} OR
          phone ILIKE $${paramCount}
        )`);
        params.push(`%${search}%`);
      }

      if (is_active !== undefined) {
        paramCount++;
        whereConditions.push(`is_active = $${paramCount}`);
        params.push(is_active === 'true');
      }

      if (country) {
        paramCount++;
        whereConditions.push(`country ILIKE $${paramCount}`);
        params.push(`%${country}%`);
      }

      const whereClause = whereConditions.length > 0 ? 'WHERE ' + whereConditions.join(' AND ') : '';
      
      // Validate sort parameters
      const validSortColumns = ['supplier_name', 'contact_person', 'city', 'created_at', 'updated_at'];
      const validSortOrder = ['ASC', 'DESC'];
      const safeSortBy = validSortColumns.includes(sort_by) ? sort_by : 'supplier_name';
      const safeSortOrder = validSortOrder.includes(sort_order.toUpperCase()) ? sort_order.toUpperCase() : 'ASC';

      const suppliersQuery = `
        SELECT 
          s.*,
          COUNT(po.po_id) as total_purchase_orders,
          COUNT(po.po_id) FILTER (WHERE po.status = 'pending') as pending_orders,
          COALESCE(SUM(po.total_amount) FILTER (WHERE po.status != 'cancelled'), 0) as total_order_value,
          MAX(po.order_date) as last_order_date
        FROM suppliers s
        LEFT JOIN purchase_orders po ON s.supplier_id = po.supplier_id
        ${whereClause}
        GROUP BY s.supplier_id
        ORDER BY s.${safeSortBy} ${safeSortOrder}
        LIMIT $${paramCount + 1} OFFSET $${paramCount + 2}
      `;

      params.push(limit, offset);

      const result = await query(suppliersQuery, params);

      // Get total count for pagination
      const countQuery = `
        SELECT COUNT(*) as total
        FROM suppliers s
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
      console.error('Error fetching suppliers:', error);
      res.status(500).json({
        success: false,
        message: 'Error fetching suppliers',
        error: error.message
      });
    }
  }

  // Get single supplier by ID
  async getSupplierById(req, res) {
    try {
      const { id } = req.params;

      const supplierQuery = `
        SELECT 
          s.*,
          COUNT(po.po_id) as total_purchase_orders,
          COUNT(po.po_id) FILTER (WHERE po.status = 'pending') as pending_orders,
          COUNT(po.po_id) FILTER (WHERE po.status = 'received') as completed_orders,
          COALESCE(SUM(po.total_amount) FILTER (WHERE po.status != 'cancelled'), 0) as total_order_value,
          COALESCE(AVG(po.total_amount) FILTER (WHERE po.status != 'cancelled'), 0) as average_order_value,
          MAX(po.order_date) as last_order_date,
          MIN(po.order_date) as first_order_date
        FROM suppliers s
        LEFT JOIN purchase_orders po ON s.supplier_id = po.supplier_id
        WHERE s.supplier_id = $1
        GROUP BY s.supplier_id
      `;

      const result = await query(supplierQuery, [id]);

      if (result.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'Supplier not found'
        });
      }

      res.json({
        success: true,
        data: result.rows[0]
      });
    } catch (error) {
      console.error('Error fetching supplier:', error);
      res.status(500).json({
        success: false,
        message: 'Error fetching supplier',
        error: error.message
      });
    }
  }

  // Create new supplier
  async createSupplier(req, res) {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          message: 'Validation errors',
          errors: errors.array()
        });
      }

      const {
        supplier_name,
        contact_person,
        phone,
        email,
        address,
        city,
        state,
        postal_code,
        country = 'Canada',
        tax_id,
        payment_terms = 30,
        is_active = true
      } = req.body;

      // Check if supplier with same name already exists
      const existingSupplier = await query(
        'SELECT supplier_id FROM suppliers WHERE supplier_name = $1 AND is_active = true',
        [supplier_name]
      );

      if (existingSupplier.rows.length > 0) {
        return res.status(400).json({
          success: false,
          message: 'Supplier with this name already exists'
        });
      }

      const insertQuery = `
        INSERT INTO suppliers (
          supplier_name, contact_person, phone, email, address,
          city, state, postal_code, country, tax_id, payment_terms, is_active
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        RETURNING *
      `;

      const result = await query(insertQuery, [
        supplier_name,
        contact_person,
        phone,
        email,
        address,
        city,
        state,
        postal_code,
        country,
        tax_id,
        payment_terms,
        is_active
      ]);

      res.status(201).json({
        success: true,
        message: 'Supplier created successfully',
        data: result.rows[0]
      });
    } catch (error) {
      console.error('Error creating supplier:', error);
      res.status(500).json({
        success: false,
        message: 'Error creating supplier',
        error: error.message
      });
    }
  }

  // Update supplier
  async updateSupplier(req, res) {
    try {
      const { id } = req.params;
      const errors = validationResult(req);
      
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          message: 'Validation errors',
          errors: errors.array()
        });
      }

      const {
        supplier_name,
        contact_person,
        phone,
        email,
        address,
        city,
        state,
        postal_code,
        country,
        tax_id,
        payment_terms,
        is_active
      } = req.body;

      // Check if supplier exists
      const existingSupplier = await query(
        'SELECT supplier_id FROM suppliers WHERE supplier_id = $1',
        [id]
      );

      if (existingSupplier.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'Supplier not found'
        });
      }

      // Check if another supplier has the same name (excluding current one)
      if (supplier_name) {
        const nameCheck = await query(
          'SELECT supplier_id FROM suppliers WHERE supplier_name = $1 AND supplier_id != $2 AND is_active = true',
          [supplier_name, id]
        );

        if (nameCheck.rows.length > 0) {
          return res.status(400).json({
            success: false,
            message: 'Another supplier with this name already exists'
          });
        }
      }

      const updateQuery = `
        UPDATE suppliers SET
          supplier_name = COALESCE($1, supplier_name),
          contact_person = COALESCE($2, contact_person),
          phone = COALESCE($3, phone),
          email = COALESCE($4, email),
          address = COALESCE($5, address),
          city = COALESCE($6, city),
          state = COALESCE($7, state),
          postal_code = COALESCE($8, postal_code),
          country = COALESCE($9, country),
          tax_id = COALESCE($10, tax_id),
          payment_terms = COALESCE($11, payment_terms),
          is_active = COALESCE($12, is_active),
          updated_at = NOW()
        WHERE supplier_id = $13
        RETURNING *
      `;

      const result = await query(updateQuery, [
        supplier_name,
        contact_person,
        phone,
        email,
        address,
        city,
        state,
        postal_code,
        country,
        tax_id,
        payment_terms,
        is_active,
        id
      ]);

      res.json({
        success: true,
        message: 'Supplier updated successfully',
        data: result.rows[0]
      });
    } catch (error) {
      console.error('Error updating supplier:', error);
      res.status(500).json({
        success: false,
        message: 'Error updating supplier',
        error: error.message
      });
    }
  }

  // Deactivate supplier (soft delete)
  async deactivateSupplier(req, res) {
    try {
      const { id } = req.params;

      // Check if supplier has pending purchase orders
      const pendingOrdersCheck = await query(
        'SELECT COUNT(*) as count FROM purchase_orders WHERE supplier_id = $1 AND status IN (\'pending\', \'ordered\', \'partially_received\')',
        [id]
      );

      if (parseInt(pendingOrdersCheck.rows[0].count) > 0) {
        return res.status(400).json({
          success: false,
          message: 'Cannot deactivate supplier with pending purchase orders'
        });
      }

      const result = await query(
        'UPDATE suppliers SET is_active = false, updated_at = NOW() WHERE supplier_id = $1 RETURNING *',
        [id]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'Supplier not found'
        });
      }

      res.json({
        success: true,
        message: 'Supplier deactivated successfully',
        data: result.rows[0]
      });
    } catch (error) {
      console.error('Error deactivating supplier:', error);
      res.status(500).json({
        success: false,
        message: 'Error deactivating supplier',
        error: error.message
      });
    }
  }

  // Get supplier purchase history
  async getSupplierPurchaseHistory(req, res) {
    try {
      const { id } = req.params;
      const {
        page = 1,
        limit = 20,
        status,
        date_from,
        date_to
      } = req.query;

      const offset = (page - 1) * limit;
      let whereConditions = [`po.supplier_id = $1`];
      let params = [id];
      let paramCount = 1;

      if (status) {
        paramCount++;
        whereConditions.push(`po.status = $${paramCount}`);
        params.push(status);
      }

      if (date_from) {
        paramCount++;
        whereConditions.push(`po.order_date >= $${paramCount}`);
        params.push(date_from);
      }

      if (date_to) {
        paramCount++;
        whereConditions.push(`po.order_date <= $${paramCount}`);
        params.push(date_to);
      }

      const whereClause = 'WHERE ' + whereConditions.join(' AND ');

      const historyQuery = `
        SELECT 
          po.po_id,
          po.po_number,
          po.order_date,
          po.expected_delivery_date,
          po.actual_delivery_date,
          po.status,
          po.total_amount,
          COUNT(poi.po_item_id) as total_items,
          u.first_name || ' ' || u.last_name as created_by_name
        FROM purchase_orders po
        LEFT JOIN purchase_order_items poi ON po.po_id = poi.po_id
        LEFT JOIN users u ON po.created_by = u.user_id
        ${whereClause}
        GROUP BY po.po_id, u.first_name, u.last_name
        ORDER BY po.order_date DESC
        LIMIT $${paramCount + 1} OFFSET $${paramCount + 2}
      `;

      params.push(limit, offset);

      const result = await query(historyQuery, params);

      // Get total count
      const countQuery = `
        SELECT COUNT(*) as total
        FROM purchase_orders po
        ${whereClause}
      `;

      const countParams = params.slice(0, -2);
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
      console.error('Error fetching supplier purchase history:', error);
      res.status(500).json({
        success: false,
        message: 'Error fetching supplier purchase history',
        error: error.message
      });
    }
  }

  // Get supplier performance metrics
  async getSupplierPerformance(req, res) {
    try {
      const { id } = req.params;
      const { period = '90' } = req.query; // days

      const performanceQuery = `
        SELECT 
          s.supplier_name,
          COUNT(po.po_id) as total_orders,
          COUNT(po.po_id) FILTER (WHERE po.status = 'received') as completed_orders,
          COUNT(po.po_id) FILTER (WHERE po.status = 'cancelled') as cancelled_orders,
          COUNT(po.po_id) FILTER (WHERE po.actual_delivery_date > po.expected_delivery_date) as late_deliveries,
          COALESCE(SUM(po.total_amount) FILTER (WHERE po.status = 'received'), 0) as total_value,
          COALESCE(AVG(po.total_amount) FILTER (WHERE po.status = 'received'), 0) as avg_order_value,
          COALESCE(
            AVG(EXTRACT(days FROM (po.actual_delivery_date - po.expected_delivery_date))) 
            FILTER (WHERE po.actual_delivery_date IS NOT NULL), 0
          ) as avg_delivery_delay_days,
          ROUND(
            COALESCE(
              COUNT(po.po_id) FILTER (WHERE po.actual_delivery_date <= po.expected_delivery_date) * 100.0 / 
              NULLIF(COUNT(po.po_id) FILTER (WHERE po.actual_delivery_date IS NOT NULL), 0), 0
            ), 2
          ) as on_time_delivery_rate
        FROM suppliers s
        LEFT JOIN purchase_orders po ON s.supplier_id = po.supplier_id 
          AND po.order_date >= CURRENT_DATE - INTERVAL '${parseInt(period)} days'
        WHERE s.supplier_id = $1
        GROUP BY s.supplier_id, s.supplier_name
      `;

      const result = await query(performanceQuery, [id]);

      if (result.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'Supplier not found'
        });
      }

      res.json({
        success: true,
        data: result.rows[0],
        period_days: parseInt(period)
      });
    } catch (error) {
      console.error('Error fetching supplier performance:', error);
      res.status(500).json({
        success: false,
        message: 'Error fetching supplier performance',
        error: error.message
      });
    }
  }

  // Get top suppliers by various metrics
  async getTopSuppliers(req, res) {
    try {
      const { 
        metric = 'total_value', // total_value, order_count, on_time_rate
        period = '90',
        limit = 10 
      } = req.query;

      let orderByClause;
      switch (metric) {
        case 'order_count':
          orderByClause = 'total_orders DESC';
          break;
        case 'on_time_rate':
          orderByClause = 'on_time_delivery_rate DESC';
          break;
        case 'total_value':
        default:
          orderByClause = 'total_value DESC';
          break;
      }

      const topSuppliersQuery = `
        SELECT 
          s.supplier_id,
          s.supplier_name,
          s.contact_person,
          s.city,
          s.country,
          COUNT(po.po_id) as total_orders,
          COALESCE(SUM(po.total_amount) FILTER (WHERE po.status = 'received'), 0) as total_value,
          ROUND(
            COALESCE(
              COUNT(po.po_id) FILTER (WHERE po.actual_delivery_date <= po.expected_delivery_date) * 100.0 / 
              NULLIF(COUNT(po.po_id) FILTER (WHERE po.actual_delivery_date IS NOT NULL), 0), 0
            ), 2
          ) as on_time_delivery_rate,
          MAX(po.order_date) as last_order_date
        FROM suppliers s
        LEFT JOIN purchase_orders po ON s.supplier_id = po.supplier_id 
          AND po.order_date >= CURRENT_DATE - INTERVAL '${parseInt(period)} days'
        WHERE s.is_active = true
        GROUP BY s.supplier_id, s.supplier_name, s.contact_person, s.city, s.country
        HAVING COUNT(po.po_id) > 0
        ORDER BY ${orderByClause}
        LIMIT $1
      `;

      const result = await query(topSuppliersQuery, [limit]);

      res.json({
        success: true,
        data: result.rows,
        metric,
        period_days: parseInt(period)
      });
    } catch (error) {
      console.error('Error fetching top suppliers:', error);
      res.status(500).json({
        success: false,
        message: 'Error fetching top suppliers',
        error: error.message
      });
    }
  }

  // Get supplier statistics
  async getSupplierStats(req, res) {
    try {
      const statsQuery = `
        SELECT 
          COUNT(*) as total_suppliers,
          COUNT(*) FILTER (WHERE is_active = true) as active_suppliers,
          COUNT(*) FILTER (WHERE is_active = false) as inactive_suppliers,
          COUNT(DISTINCT country) as countries_count,
          COALESCE(AVG(payment_terms), 0) as avg_payment_terms
        FROM suppliers
      `;

      const result = await query(statsQuery);

      res.json({
        success: true,
        data: result.rows[0]
      });
    } catch (error) {
      console.error('Error fetching supplier statistics:', error);
      res.status(500).json({
        success: false,
        message: 'Error fetching supplier statistics',
        error: error.message
      });
    }
  }
}

module.exports = new SupplierController();
