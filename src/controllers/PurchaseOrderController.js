const { pool, transaction } = require('../config/database');
const { validationResult } = require('express-validator');

class PurchaseOrderController {
  // Get all purchase orders with filtering and pagination
  async getAllPurchaseOrders(req, res) {
    try {
      const {
        page = 1,
        limit = 50,
        status,
        supplier_id,
        date_from,
        date_to,
        search
      } = req.query;

      const offset = (page - 1) * limit;
      let whereConditions = [];
      let params = [];
      let paramCount = 0;

      if (status) {
        paramCount++;
        whereConditions.push(`po.status = $${paramCount}`);
        params.push(status);
      }

      if (supplier_id) {
        paramCount++;
        whereConditions.push(`po.supplier_id = $${paramCount}`);
        params.push(supplier_id);
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

      if (search) {
        paramCount++;
        whereConditions.push(`(po.po_number ILIKE $${paramCount} OR s.supplier_name ILIKE $${paramCount})`);
        params.push(`%${search}%`);
      }

      const whereClause = whereConditions.length > 0 ? 'WHERE ' + whereConditions.join(' AND ') : '';

      const query = `
        SELECT 
          po.*,
          s.supplier_name,
          s.contact_person,
          u.first_name || ' ' || u.last_name as created_by_name,
          COUNT(poi.po_item_id) as total_items,
          COALESCE(SUM(poi.quantity_ordered), 0) as total_quantity_ordered,
          COALESCE(SUM(poi.quantity_received), 0) as total_quantity_received
        FROM purchase_orders po
        LEFT JOIN suppliers s ON po.supplier_id = s.supplier_id
        LEFT JOIN users u ON po.created_by = u.user_id
        LEFT JOIN purchase_order_items poi ON po.po_id = poi.po_id
        ${whereClause}
        GROUP BY po.po_id, s.supplier_name, s.contact_person, u.first_name, u.last_name
        ORDER BY po.order_date DESC
        LIMIT $${paramCount + 1} OFFSET $${paramCount + 2}
      `;

      params.push(limit, offset);

      const result = await pool.query(query, params);

      // Get total count for pagination
      const countQuery = `
        SELECT COUNT(DISTINCT po.po_id) as total
        FROM purchase_orders po
        LEFT JOIN suppliers s ON po.supplier_id = s.supplier_id
        ${whereClause}
      `;

      const countParams = params.slice(0, -2); // Remove limit and offset
      const countResult = await pool.query(countQuery, countParams);
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
      console.error('Error fetching purchase orders:', error);
      res.status(500).json({
        success: false,
        message: 'Error fetching purchase orders',
        error: error.message
      });
    }
  }

  // Get single purchase order with items
  async getPurchaseOrderById(req, res) {
    try {
      const { id } = req.params;

      // Get purchase order details
      const poQuery = `
        SELECT 
          po.*,
          s.supplier_name,
          s.contact_person,
          s.phone,
          s.email,
          s.address,
          u.first_name || ' ' || u.last_name as created_by_name
        FROM purchase_orders po
        LEFT JOIN suppliers s ON po.supplier_id = s.supplier_id
        LEFT JOIN users u ON po.created_by = u.user_id
        WHERE po.po_id = $1
      `;

      const poResult = await pool.query(poQuery, [id]);

      if (poResult.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'Purchase order not found'
        });
      }

      // Get purchase order items
      const itemsQuery = `
        SELECT 
          poi.*,
          p.product_code,
          p.product_name,
          p.brand_name,
          p.unit_of_measure,
          (poi.quantity_ordered - poi.quantity_received) as quantity_pending
        FROM purchase_order_items poi
        JOIN products p ON poi.product_id = p.product_id
        WHERE poi.po_id = $1
        ORDER BY poi.po_item_id
      `;

      const itemsResult = await pool.query(itemsQuery, [id]);

      const purchaseOrder = {
        ...poResult.rows[0],
        items: itemsResult.rows
      };

      res.json({
        success: true,
        data: purchaseOrder
      });
    } catch (error) {
      console.error('Error fetching purchase order:', error);
      res.status(500).json({
        success: false,
        message: 'Error fetching purchase order',
        error: error.message
      });
    }
  }

  // Create new purchase order
  async createPurchaseOrder(req, res) {
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
        supplier_id,
        expected_delivery_date,
        notes,
        items = []
      } = req.body;

      const created_by = req.user?.user_id;

      if (!items || items.length === 0) {
        return res.status(400).json({
          success: false,
          message: 'Purchase order must have at least one item'
        });
      }

      const result = await transaction(async (client) => {
        // Create purchase order
        const poQuery = `
          INSERT INTO purchase_orders (
            supplier_id, 
            expected_delivery_date, 
            notes, 
            created_by,
            status
          ) VALUES ($1, $2, $3, $4, 'pending')
          RETURNING *
        `;

        const poResult = await client.query(poQuery, [
          supplier_id,
          expected_delivery_date,
          notes,
          created_by
        ]);

        const po_id = poResult.rows[0].po_id;
        let subtotal = 0;

        // Add items
        for (const item of items) {
          const { product_id, quantity_ordered, unit_cost } = item;
          const line_total = quantity_ordered * unit_cost;
          subtotal += line_total;

          const itemQuery = `
            INSERT INTO purchase_order_items (
              po_id, 
              product_id, 
              quantity_ordered, 
              unit_cost, 
              line_total,
              status
            ) VALUES ($1, $2, $3, $4, $5, 'pending')
          `;

          await client.query(itemQuery, [
            po_id,
            product_id,
            quantity_ordered,
            unit_cost,
            line_total
          ]);
        }

        // Update purchase order totals
        const tax_amount = subtotal * 0.13; // Assuming 13% tax (HST in Canada)
        const total_amount = subtotal + tax_amount;

        const updatePoQuery = `
          UPDATE purchase_orders 
          SET subtotal = $1, tax_amount = $2, total_amount = $3
          WHERE po_id = $4
        `;

        await client.query(updatePoQuery, [subtotal, tax_amount, total_amount, po_id]);

        return po_id;
      });

      // Fetch the complete purchase order
      const completePoQuery = `
        SELECT 
          po.*,
          s.supplier_name
        FROM purchase_orders po
        JOIN suppliers s ON po.supplier_id = s.supplier_id
        WHERE po.po_id = $1
      `;

      const completePo = await pool.query(completePoQuery, [result]);

      res.status(201).json({
        success: true,
        message: 'Purchase order created successfully',
        data: completePo.rows[0]
      });
    } catch (error) {
      console.error('Error creating purchase order:', error);
      res.status(500).json({
        success: false,
        message: 'Error creating purchase order',
        error: error.message
      });
    }
  }

  // Update purchase order status
  async updatePurchaseOrderStatus(req, res) {
    try {
      const { id } = req.params;
      const { status, notes } = req.body;

      const validStatuses = ['pending', 'ordered', 'partially_received', 'received', 'cancelled'];
      
      if (!validStatuses.includes(status)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid status'
        });
      }

      const updateQuery = `
        UPDATE purchase_orders 
        SET status = $1, notes = COALESCE($2, notes), updated_at = NOW()
        WHERE po_id = $3
        RETURNING *
      `;

      const result = await pool.query(updateQuery, [status, notes, id]);

      if (result.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'Purchase order not found'
        });
      }

      res.json({
        success: true,
        message: 'Purchase order status updated successfully',
        data: result.rows[0]
      });
    } catch (error) {
      console.error('Error updating purchase order status:', error);
      res.status(500).json({
        success: false,
        message: 'Error updating purchase order status',
        error: error.message
      });
    }
  }

  // Receive goods (partial or full)
  async receiveGoods(req, res) {
    try {
      const { id } = req.params;
      const { 
        items = [], // Array of {po_item_id, quantity_received, batch_number, expiration_date}
        actual_delivery_date,
        notes 
      } = req.body;

      if (!items || items.length === 0) {
        return res.status(400).json({
          success: false,
          message: 'No items to receive'
        });
      }

      const result = await transaction(async (client) => {
        // Process each received item
        for (const item of items) {
          const { 
            po_item_id, 
            quantity_received, 
            batch_number, 
            expiration_date,
            lot_number 
          } = item;

          // Get PO item details
          const poItemQuery = `
            SELECT poi.*, p.product_id
            FROM purchase_order_items poi
            JOIN products p ON poi.product_id = p.product_id
            WHERE poi.po_item_id = $1 AND poi.po_id = $2
          `;

          const poItemResult = await client.query(poItemQuery, [po_item_id, id]);

          if (poItemResult.rows.length === 0) {
            throw new Error(`Purchase order item ${po_item_id} not found`);
          }

          const poItem = poItemResult.rows[0];
          const newQuantityReceived = poItem.quantity_received + quantity_received;

          if (newQuantityReceived > poItem.quantity_ordered) {
            throw new Error(`Cannot receive more than ordered quantity for item ${po_item_id}`);
          }

          // Update purchase order item
          const newStatus = newQuantityReceived === poItem.quantity_ordered ? 'received' : 'partially_received';
          
          const updatePoItemQuery = `
            UPDATE purchase_order_items 
            SET quantity_received = $1, status = $2
            WHERE po_item_id = $3
          `;

          await client.query(updatePoItemQuery, [newQuantityReceived, newStatus, po_item_id]);

          // Add to inventory
          const inventoryQuery = `
            INSERT INTO inventory (
              product_id,
              supplier_id,
              batch_number,
              lot_number,
              quantity_on_hand,
              unit_cost,
              expiration_date,
              received_date,
              status
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), 'active')
          `;

          await client.query(inventoryQuery, [
            poItem.product_id,
            (await client.query('SELECT supplier_id FROM purchase_orders WHERE po_id = $1', [id])).rows[0].supplier_id,
            batch_number,
            lot_number,
            quantity_received,
            poItem.unit_cost,
            expiration_date
          ]);
        }

        // Update purchase order status
        const checkStatusQuery = `
          SELECT 
            COUNT(*) as total_items,
            COUNT(*) FILTER (WHERE status = 'received') as received_items,
            COUNT(*) FILTER (WHERE status = 'partially_received') as partial_items
          FROM purchase_order_items
          WHERE po_id = $1
        `;

        const statusResult = await client.query(checkStatusQuery, [id]);
        const { total_items, received_items, partial_items } = statusResult.rows[0];

        let poStatus = 'ordered';
        if (parseInt(received_items) === parseInt(total_items)) {
          poStatus = 'received';
        } else if (parseInt(partial_items) > 0 || parseInt(received_items) > 0) {
          poStatus = 'partially_received';
        }

        const updatePoQuery = `
          UPDATE purchase_orders 
          SET 
            status = $1,
            actual_delivery_date = COALESCE($2, actual_delivery_date),
            notes = COALESCE($3, notes),
            updated_at = NOW()
          WHERE po_id = $4
          RETURNING *
        `;

        const poResult = await client.query(updatePoQuery, [
          poStatus,
          actual_delivery_date,
          notes,
          id
        ]);

        return poResult.rows[0];
      });

      res.json({
        success: true,
        message: 'Goods received successfully',
        data: result
      });
    } catch (error) {
      console.error('Error receiving goods:', error);
      res.status(500).json({
        success: false,
        message: 'Error receiving goods',
        error: error.message
      });
    }
  }

  // Get purchase order statistics
  async getPurchaseOrderStats(req, res) {
    try {
      const statsQuery = `
        SELECT 
          COUNT(*) as total_orders,
          COUNT(*) FILTER (WHERE status = 'pending') as pending_orders,
          COUNT(*) FILTER (WHERE status = 'ordered') as ordered_orders,
          COUNT(*) FILTER (WHERE status = 'partially_received') as partial_orders,
          COUNT(*) FILTER (WHERE status = 'received') as completed_orders,
          COUNT(*) FILTER (WHERE status = 'cancelled') as cancelled_orders,
          COALESCE(SUM(total_amount) FILTER (WHERE status != 'cancelled'), 0) as total_value,
          COALESCE(AVG(total_amount) FILTER (WHERE status != 'cancelled'), 0) as average_order_value
        FROM purchase_orders
        WHERE order_date >= CURRENT_DATE - INTERVAL '30 days'
      `;

      const result = await pool.query(statsQuery);

      res.json({
        success: true,
        data: result.rows[0]
      });
    } catch (error) {
      console.error('Error fetching purchase order stats:', error);
      res.status(500).json({
        success: false,
        message: 'Error fetching purchase order statistics',
        error: error.message
      });
    }
  }

  // Get overdue purchase orders
  async getOverduePurchaseOrders(req, res) {
    try {
      const query = `
        SELECT 
          po.*,
          s.supplier_name,
          s.contact_person,
          s.phone,
          (CURRENT_DATE - po.expected_delivery_date) as days_overdue
        FROM purchase_orders po
        JOIN suppliers s ON po.supplier_id = s.supplier_id
        WHERE po.expected_delivery_date < CURRENT_DATE
          AND po.status IN ('pending', 'ordered', 'partially_received')
        ORDER BY po.expected_delivery_date ASC
      `;

      const result = await pool.query(query);

      res.json({
        success: true,
        data: result.rows
      });
    } catch (error) {
      console.error('Error fetching overdue purchase orders:', error);
      res.status(500).json({
        success: false,
        message: 'Error fetching overdue purchase orders',
        error: error.message
      });
    }
  }

  // Cancel purchase order
  async cancelPurchaseOrder(req, res) {
    try {
      const { id } = req.params;
      const { cancellation_reason } = req.body;

      // Check if PO can be cancelled
      const checkQuery = `
        SELECT status FROM purchase_orders WHERE po_id = $1
      `;

      const checkResult = await pool.query(checkQuery, [id]);

      if (checkResult.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'Purchase order not found'
        });
      }

      const currentStatus = checkResult.rows[0].status;
      if (['received', 'cancelled'].includes(currentStatus)) {
        return res.status(400).json({
          success: false,
          message: 'Cannot cancel a purchase order that is already received or cancelled'
        });
      }

      const updateQuery = `
        UPDATE purchase_orders 
        SET 
          status = 'cancelled',
          notes = CONCAT(COALESCE(notes, ''), 
                        CASE WHEN notes IS NOT NULL AND notes != '' THEN E'\n' ELSE '' END,
                        'Cancelled: ', $2),
          updated_at = NOW()
        WHERE po_id = $1
        RETURNING *
      `;

      const result = await pool.query(updateQuery, [id, cancellation_reason || 'No reason provided']);

      res.json({
        success: true,
        message: 'Purchase order cancelled successfully',
        data: result.rows[0]
      });
    } catch (error) {
      console.error('Error cancelling purchase order:', error);
      res.status(500).json({
        success: false,
        message: 'Error cancelling purchase order',
        error: error.message
      });
    }
  }
}

module.exports = new PurchaseOrderController();
