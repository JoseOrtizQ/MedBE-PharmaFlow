const { query, transaction } = require('../config/database');
const logger = require('../utils/logger');

class SalesController {
  /**
   * Create a new sale transaction
   */
  static async createSale(req, res) {
    try {
      const {
        customerId,
        items, // Array of { productId, quantity, unitPrice, discountPercentage, inventoryId }
        paymentMethod,
        prescriptionNumber,
        doctorName,
        insuranceClaimAmount = 0,
        customerPaymentAmount,
        notes
      } = req.body;

      const cashierId = req.user.userId;

      // Input validation
      if (!items || !Array.isArray(items) || items.length === 0) {
        return res.status(400).json({
          success: false,
          message: 'At least one item is required for the sale'
        });
      }

      if (!paymentMethod) {
        return res.status(400).json({
          success: false,
          message: 'Payment method is required'
        });
      }

      const validPaymentMethods = ['cash', 'card', 'insurance', 'check', 'digital'];
      if (!validPaymentMethods.includes(paymentMethod)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid payment method'
        });
      }

      await transaction(async (client) => {
        // Calculate sale totals
        let subtotal = 0;
        let totalTaxAmount = 0;
        const processedItems = [];

        // Validate and process each item
        for (const item of items) {
          const { productId, quantity, unitPrice, discountPercentage = 0, inventoryId } = item;

          if (!productId || !quantity || quantity <= 0) {
            throw new Error('Invalid item: productId and positive quantity required');
          }

          // Get product details including tax rate
          const productQuery = `
            SELECT p.product_id, p.product_name, p.requires_prescription, 
                   p.controlled_substance, p.tax_rate, p.selling_price
            FROM products p 
            WHERE p.product_id = $1 AND p.is_active = TRUE
          `;
          const productResult = await client.query(productQuery, [productId]);

          if (productResult.rows.length === 0) {
            throw new Error(`Product with ID ${productId} not found or inactive`);
          }

          const product = productResult.rows[0];

          // Check if prescription is required
          if (product.requires_prescription && !prescriptionNumber) {
            throw new Error(`Prescription required for product: ${product.product_name}`);
          }

          // Verify inventory availability
          let inventoryCheck;
          if (inventoryId) {
            // Specific inventory batch requested
            inventoryCheck = await client.query(`
              SELECT inventory_id, quantity_available, expiration_date, batch_number, unit_cost
              FROM inventory 
              WHERE inventory_id = $1 AND product_id = $2 AND status = 'active' AND quantity_available >= $3
            `, [inventoryId, productId, quantity]);
          } else {
            // Use FIFO - first expiring available inventory
            inventoryCheck = await client.query(`
              SELECT inventory_id, quantity_available, expiration_date, batch_number, unit_cost
              FROM inventory 
              WHERE product_id = $1 AND status = 'active' AND quantity_available >= $2
              ORDER BY expiration_date ASC 
              LIMIT 1
            `, [productId, quantity]);
          }

          if (inventoryCheck.rows.length === 0) {
            throw new Error(`Insufficient inventory for product: ${product.product_name}`);
          }

          const inventory = inventoryCheck.rows[0];

          // Reserve inventory (update quantity_reserved)
          await client.query(`
            UPDATE inventory 
            SET quantity_reserved = quantity_reserved + $1
            WHERE inventory_id = $2
          `, [quantity, inventory.inventory_id]);

          // Calculate line totals
          const lineSubtotal = unitPrice * quantity;
          const discountAmount = (lineSubtotal * discountPercentage) / 100;
          const lineTotal = lineSubtotal - discountAmount;
          const lineTaxAmount = (lineTotal * product.tax_rate) / 100;

          subtotal += lineTotal;
          totalTaxAmount += lineTaxAmount;

          processedItems.push({
            productId,
            inventoryId: inventory.inventory_id,
            quantity,
            unitPrice,
            discountPercentage,
            discountAmount,
            lineTotal,
            expirationDate: inventory.expiration_date,
            batchNumber: inventory.batch_number
          });
        }

        const totalAmount = subtotal + totalTaxAmount;

        // Validate payment amounts
        const totalPayments = Number(insuranceClaimAmount) + Number(customerPaymentAmount);
        if (Math.abs(totalPayments - totalAmount) > 0.01) { // Allow for small rounding differences
          throw new Error('Payment amounts do not match total amount');
        }

        // Create sale record
        const saleQuery = `
          INSERT INTO sales (
            customer_id, cashier_id, subtotal, tax_amount, total_amount,
            payment_method, prescription_number, doctor_name,
            insurance_claim_amount, customer_payment_amount, notes
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
          RETURNING sale_id, sale_number, sale_date
        `;

        const saleResult = await client.query(saleQuery, [
          customerId, cashierId, subtotal, totalTaxAmount, totalAmount,
          paymentMethod, prescriptionNumber, doctorName,
          insuranceClaimAmount, customerPaymentAmount, notes
        ]);

        const sale = saleResult.rows[0];

        // Insert sale items
        for (const item of processedItems) {
          await client.query(`
            INSERT INTO sale_items (
              sale_id, product_id, inventory_id, quantity, unit_price,
              discount_percentage, discount_amount, line_total,
              expiration_date, batch_number
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
          `, [
            sale.sale_id, item.productId, item.inventoryId, item.quantity,
            item.unitPrice, item.discountPercentage, item.discountAmount,
            item.lineTotal, item.expirationDate, item.batchNumber
          ]);

          // Update actual inventory quantities
          await client.query(`
            UPDATE inventory 
            SET 
              quantity_on_hand = quantity_on_hand - $1,
              quantity_reserved = quantity_reserved - $1
            WHERE inventory_id = $2
          `, [item.quantity, item.inventoryId]);
        }

        logger.info('Sale created successfully', {
          saleId: sale.sale_id,
          saleNumber: sale.sale_number,
          totalAmount,
          itemCount: processedItems.length,
          cashierId
        });

        res.status(201).json({
          success: true,
          message: 'Sale created successfully',
          data: {
            sale: {
              id: sale.sale_id,
              saleNumber: sale.sale_number,
              saleDate: sale.sale_date,
              subtotal,
              taxAmount: totalTaxAmount,
              totalAmount,
              paymentMethod,
              itemCount: processedItems.length
            }
          }
        });
      });

    } catch (error) {
      logger.error('Create sale error:', error.message);
      res.status(400).json({
        success: false,
        message: error.message || 'Failed to create sale'
      });
    }
  }

  /**
   * Get sale by ID with full details
   */
  static async getSaleById(req, res) {
    try {
      const { saleId } = req.params;

      const saleQuery = `
        SELECT 
          s.*,
          c.first_name as customer_first_name,
          c.last_name as customer_last_name,
          c.customer_code,
          u.first_name as cashier_first_name,
          u.last_name as cashier_last_name
        FROM sales s
        LEFT JOIN customers c ON s.customer_id = c.customer_id
        JOIN users u ON s.cashier_id = u.user_id
        WHERE s.sale_id = $1
      `;

      const saleResult = await query(saleQuery, [saleId]);

      if (saleResult.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'Sale not found'
        });
      }

      const sale = saleResult.rows[0];

      // Get sale items
      const itemsQuery = `
        SELECT 
          si.*,
          p.product_name,
          p.product_code,
          p.generic_name,
          p.brand_name,
          p.dosage_form,
          p.strength
        FROM sale_items si
        JOIN products p ON si.product_id = p.product_id
        WHERE si.sale_id = $1
        ORDER BY si.sale_item_id
      `;

      const itemsResult = await query(itemsQuery, [saleId]);

      res.json({
        success: true,
        data: {
          sale: {
            id: sale.sale_id,
            saleNumber: sale.sale_number,
            saleDate: sale.sale_date,
            customer: sale.customer_id ? {
              id: sale.customer_id,
              name: `${sale.customer_first_name} ${sale.customer_last_name}`,
              code: sale.customer_code
            } : null,
            cashier: {
              id: sale.cashier_id,
              name: `${sale.cashier_first_name} ${sale.cashier_last_name}`
            },
            subtotal: sale.subtotal,
            taxAmount: sale.tax_amount,
            discountAmount: sale.discount_amount,
            totalAmount: sale.total_amount,
            paymentMethod: sale.payment_method,
            paymentStatus: sale.payment_status,
            prescriptionNumber: sale.prescription_number,
            doctorName: sale.doctor_name,
            insuranceClaimAmount: sale.insurance_claim_amount,
            customerPaymentAmount: sale.customer_payment_amount,
            notes: sale.notes,
            items: itemsResult.rows.map(item => ({
              id: item.sale_item_id,
              product: {
                id: item.product_id,
                name: item.product_name,
                code: item.product_code,
                genericName: item.generic_name,
                brandName: item.brand_name,
                dosageForm: item.dosage_form,
                strength: item.strength
              },
              quantity: item.quantity,
              unitPrice: item.unit_price,
              discountPercentage: item.discount_percentage,
              discountAmount: item.discount_amount,
              lineTotal: item.line_total,
              batchNumber: item.batch_number,
              expirationDate: item.expiration_date
            }))
          }
        }
      });

    } catch (error) {
      logger.error('Get sale error:', error.message);
      res.status(500).json({
        success: false,
        message: 'Failed to retrieve sale'
      });
    }
  }

  /**
   * Get sales list with pagination and filters
   */
  static async getSales(req, res) {
    try {
      const {
        page = 1,
        limit = 20,
        startDate,
        endDate,
        customerId,
        cashierId,
        paymentMethod,
        prescriptionNumber,
        search
      } = req.query;

      const offset = (page - 1) * limit;
      const queryParams = [];
      let whereClause = 'WHERE 1=1';
      let paramCounter = 1;

      // Build dynamic WHERE clause
      if (startDate) {
        whereClause += ` AND s.sale_date >= $${paramCounter}`;
        queryParams.push(startDate);
        paramCounter++;
      }

      if (endDate) {
        whereClause += ` AND s.sale_date <= $${paramCounter}`;
        queryParams.push(endDate + ' 23:59:59');
        paramCounter++;
      }

      if (customerId) {
        whereClause += ` AND s.customer_id = $${paramCounter}`;
        queryParams.push(customerId);
        paramCounter++;
      }

      if (cashierId) {
        whereClause += ` AND s.cashier_id = $${paramCounter}`;
        queryParams.push(cashierId);
        paramCounter++;
      }

      if (paymentMethod) {
        whereClause += ` AND s.payment_method = $${paramCounter}`;
        queryParams.push(paymentMethod);
        paramCounter++;
      }

      if (prescriptionNumber) {
        whereClause += ` AND s.prescription_number = $${paramCounter}`;
        queryParams.push(prescriptionNumber);
        paramCounter++;
      }

      if (search) {
        whereClause += ` AND (s.sale_number ILIKE $${paramCounter} OR c.first_name ILIKE $${paramCounter} OR c.last_name ILIKE $${paramCounter})`;
        queryParams.push(`%${search}%`);
        paramCounter++;
      }

      // Get total count
      const countQuery = `
        SELECT COUNT(*) as total
        FROM sales s
        LEFT JOIN customers c ON s.customer_id = c.customer_id
        ${whereClause}
      `;

      const countResult = await query(countQuery, queryParams);
      const total = parseInt(countResult.rows[0].total);

      // Get sales data
      const salesQuery = `
        SELECT 
          s.sale_id, s.sale_number, s.sale_date, s.subtotal, s.tax_amount, 
          s.discount_amount, s.total_amount, s.payment_method, s.payment_status,
          s.prescription_number, s.doctor_name,
          c.customer_id, c.first_name as customer_first_name, c.last_name as customer_last_name, c.customer_code,
          u.first_name as cashier_first_name, u.last_name as cashier_last_name,
          COUNT(si.sale_item_id) as item_count
        FROM sales s
        LEFT JOIN customers c ON s.customer_id = c.customer_id
        JOIN users u ON s.cashier_id = u.user_id
        LEFT JOIN sale_items si ON s.sale_id = si.sale_id
        ${whereClause}
        GROUP BY s.sale_id, c.customer_id, u.user_id
        ORDER BY s.sale_date DESC
        LIMIT $${paramCounter} OFFSET $${paramCounter + 1}
      `;

      queryParams.push(limit, offset);
      const salesResult = await query(salesQuery, queryParams);

      const totalPages = Math.ceil(total / limit);

      res.json({
        success: true,
        data: {
          sales: salesResult.rows.map(sale => ({
            id: sale.sale_id,
            saleNumber: sale.sale_number,
            saleDate: sale.sale_date,
            customer: sale.customer_id ? {
              id: sale.customer_id,
              name: `${sale.customer_first_name} ${sale.customer_last_name}`,
              code: sale.customer_code
            } : null,
            cashier: {
              name: `${sale.cashier_first_name} ${sale.cashier_last_name}`
            },
            subtotal: sale.subtotal,
            taxAmount: sale.tax_amount,
            discountAmount: sale.discount_amount,
            totalAmount: sale.total_amount,
            paymentMethod: sale.payment_method,
            paymentStatus: sale.payment_status,
            prescriptionNumber: sale.prescription_number,
            doctorName: sale.doctor_name,
            itemCount: parseInt(sale.item_count)
          })),
          pagination: {
            currentPage: parseInt(page),
            totalPages,
            totalItems: total,
            itemsPerPage: parseInt(limit),
            hasNextPage: page < totalPages,
            hasPrevPage: page > 1
          }
        }
      });

    } catch (error) {
      logger.error('Get sales error:', error.message);
      res.status(500).json({
        success: false,
        message: 'Failed to retrieve sales'
      });
    }
  }

  /**
   * Process a refund for a sale
   */
  static async processRefund(req, res) {
    try {
      const { saleId } = req.params;
      const { items, reason, refundAmount } = req.body; // items: [{ saleItemId, quantityToRefund }]
      const processedBy = req.user.userId;

      if (!items || !Array.isArray(items) || items.length === 0) {
        return res.status(400).json({
          success: false,
          message: 'Items to refund are required'
        });
      }

      await transaction(async (client) => {
        // Verify sale exists and get details
        const saleQuery = `
          SELECT * FROM sales WHERE sale_id = $1 AND payment_status = 'completed'
        `;
        const saleResult = await client.query(saleQuery, [saleId]);

        if (saleResult.rows.length === 0) {
          throw new Error('Sale not found or cannot be refunded');
        }

        const sale = saleResult.rows[0];
        let totalRefundAmount = 0;

        // Process each refund item
        for (const refundItem of items) {
          const { saleItemId, quantityToRefund } = refundItem;

          // Get sale item details
          const itemQuery = `
            SELECT si.*, p.product_name
            FROM sale_items si
            JOIN products p ON si.product_id = p.product_id
            WHERE si.sale_item_id = $1 AND si.sale_id = $2
          `;
          const itemResult = await client.query(itemQuery, [saleItemId, saleId]);

          if (itemResult.rows.length === 0) {
            throw new Error(`Sale item ${saleItemId} not found`);
          }

          const item = itemResult.rows[0];

          if (quantityToRefund > item.quantity) {
            throw new Error(`Cannot refund ${quantityToRefund} of ${item.product_name}, only ${item.quantity} were sold`);
          }

          // Calculate refund amount for this item
          const itemRefundAmount = (item.line_total / item.quantity) * quantityToRefund;
          totalRefundAmount += itemRefundAmount;

          // Return inventory
          await client.query(`
            UPDATE inventory 
            SET quantity_on_hand = quantity_on_hand + $1
            WHERE inventory_id = $2
          `, [quantityToRefund, item.inventory_id]);

          // Create stock movement record
          await client.query(`
            INSERT INTO stock_movements (
              inventory_id, product_id, movement_type, quantity_change,
              quantity_before, quantity_after, reference_id, reference_type,
              reason, performed_by
            ) 
            SELECT 
              $1, $2, 'return', $3,
              i.quantity_on_hand - $3, i.quantity_on_hand,
              $4, 'sale_refund', $5, $6
            FROM inventory i WHERE i.inventory_id = $1
          `, [
            item.inventory_id, item.product_id, quantityToRefund,
            saleId, reason || 'Sale refund', processedBy
          ]);
        }

        // Validate refund amount if provided
        if (refundAmount && Math.abs(refundAmount - totalRefundAmount) > 0.01) {
          throw new Error('Provided refund amount does not match calculated amount');
        }

        // Update sale status to refunded or partially refunded
        const finalRefundAmount = refundAmount || totalRefundAmount;
        const newPaymentStatus = finalRefundAmount >= sale.total_amount ? 'refunded' : 'partial';

        await client.query(`
          UPDATE sales 
          SET payment_status = $1, notes = COALESCE(notes, '') || $2
          WHERE sale_id = $3
        `, [newPaymentStatus, `\nRefund processed: $${finalRefundAmount}. Reason: ${reason || 'N/A'}`, saleId]);

        logger.info('Refund processed successfully', {
          saleId,
          saleNumber: sale.sale_number,
          refundAmount: finalRefundAmount,
          processedBy
        });

        res.json({
          success: true,
          message: 'Refund processed successfully',
          data: {
            saleId,
            refundAmount: finalRefundAmount,
            newPaymentStatus
          }
        });
      });

    } catch (error) {
      logger.error('Process refund error:', error.message);
      res.status(400).json({
        success: false,
        message: error.message || 'Failed to process refund'
      });
    }
  }

  /**
   * Get sales analytics/reports
   */
  static async getSalesAnalytics(req, res) {
    try {
      const {
        startDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0], // Default: 30 days ago
        endDate = new Date().toISOString().split('T')[0], // Default: today
        groupBy = 'day' // day, week, month
      } = req.query;

      // Sales summary
      const summaryQuery = `
        SELECT 
          COUNT(*) as total_transactions,
          SUM(total_amount) as total_revenue,
          AVG(total_amount) as average_sale,
          SUM(tax_amount) as total_tax,
          COUNT(DISTINCT customer_id) FILTER (WHERE customer_id IS NOT NULL) as unique_customers
        FROM sales 
        WHERE sale_date BETWEEN $1 AND $2 || ' 23:59:59'
        AND payment_status IN ('completed', 'partial')
      `;

      const summaryResult = await query(summaryQuery, [startDate, endDate]);

      // Sales by payment method
      const paymentMethodQuery = `
        SELECT 
          payment_method,
          COUNT(*) as transaction_count,
          SUM(total_amount) as total_amount
        FROM sales 
        WHERE sale_date BETWEEN $1 AND $2 || ' 23:59:59'
        AND payment_status IN ('completed', 'partial')
        GROUP BY payment_method
        ORDER BY total_amount DESC
      `;

      const paymentMethodResult = await query(paymentMethodQuery, [startDate, endDate]);

      // Top selling products
      const topProductsQuery = `
        SELECT 
          p.product_name,
          p.brand_name,
          SUM(si.quantity) as total_quantity,
          SUM(si.line_total) as total_revenue
        FROM sale_items si
        JOIN products p ON si.product_id = p.product_id
        JOIN sales s ON si.sale_id = s.sale_id
        WHERE s.sale_date BETWEEN $1 AND $2 || ' 23:59:59'
        AND s.payment_status IN ('completed', 'partial')
        GROUP BY p.product_id, p.product_name, p.brand_name
        ORDER BY total_revenue DESC
        LIMIT 10
      `;

      const topProductsResult = await query(topProductsQuery, [startDate, endDate]);

      // Daily/Weekly/Monthly trends
      let dateFormat;
      switch (groupBy) {
        case 'week':
          dateFormat = "DATE_TRUNC('week', sale_date)";
          break;
        case 'month':
          dateFormat = "DATE_TRUNC('month', sale_date)";
          break;
        default:
          dateFormat = "DATE(sale_date)";
      }

      const trendsQuery = `
        SELECT 
          ${dateFormat} as period,
          COUNT(*) as transaction_count,
          SUM(total_amount) as total_revenue
        FROM sales 
        WHERE sale_date BETWEEN $1 AND $2 || ' 23:59:59'
        AND payment_status IN ('completed', 'partial')
        GROUP BY ${dateFormat}
        ORDER BY period
      `;

      const trendsResult = await query(trendsQuery, [startDate, endDate]);

      res.json({
        success: true,
        data: {
          summary: {
            totalTransactions: parseInt(summaryResult.rows[0].total_transactions),
            totalRevenue: parseFloat(summaryResult.rows[0].total_revenue || 0),
            averageSale: parseFloat(summaryResult.rows[0].average_sale || 0),
            totalTax: parseFloat(summaryResult.rows[0].total_tax || 0),
            uniqueCustomers: parseInt(summaryResult.rows[0].unique_customers)
          },
          paymentMethods: paymentMethodResult.rows.map(row => ({
            method: row.payment_method,
            transactionCount: parseInt(row.transaction_count),
            totalAmount: parseFloat(row.total_amount)
          })),
          topProducts: topProductsResult.rows.map(row => ({
            name: row.product_name,
            brand: row.brand_name,
            totalQuantity: parseInt(row.total_quantity),
            totalRevenue: parseFloat(row.total_revenue)
          })),
          trends: trendsResult.rows.map(row => ({
            period: row.period,
            transactionCount: parseInt(row.transaction_count),
            totalRevenue: parseFloat(row.total_revenue)
          })),
          dateRange: {
            startDate,
            endDate,
            groupBy
          }
        }
      });

    } catch (error) {
      logger.error('Get sales analytics error:', error.message);
      res.status(500).json({
        success: false,
        message: 'Failed to retrieve sales analytics'
      });
    }
  }
}

module.exports = SalesController;
