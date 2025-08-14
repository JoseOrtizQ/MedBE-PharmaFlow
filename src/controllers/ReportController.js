const { query, transaction } = require('../config/database');
const config = require('../config/environment');
const logger = require('../utils/logger');

class ReportController {
  /**
   * Get sales summary report
   */
  static async getSalesSummary(req, res) {
    try {
      const { 
        startDate, 
        endDate, 
        groupBy = 'day', // day, week, month
        cashierId,
        customerId 
      } = req.query;

      // Validate date range
      if (!startDate || !endDate) {
        return res.status(400).json({
          success: false,
          message: 'Start date and end date are required'
        });
      }

      // Build date grouping based on groupBy parameter
      let dateGrouping;
      switch (groupBy) {
        case 'week':
          dateGrouping = `DATE_TRUNC('week', s.sale_date)`;
          break;
        case 'month':
          dateGrouping = `DATE_TRUNC('month', s.sale_date)`;
          break;
        default:
          dateGrouping = `DATE_TRUNC('day', s.sale_date)`;
      }

      let whereConditions = ['s.sale_date >= $1', 's.sale_date <= $2'];
      let queryParams = [startDate, endDate];
      let paramIndex = 3;

      if (cashierId) {
        whereConditions.push(`s.cashier_id = $${paramIndex}`);
        queryParams.push(cashierId);
        paramIndex++;
      }

      if (customerId) {
        whereConditions.push(`s.customer_id = $${paramIndex}`);
        queryParams.push(customerId);
        paramIndex++;
      }

      const salesSummaryQuery = `
        SELECT 
          ${dateGrouping} as period,
          COUNT(s.sale_id) as total_transactions,
          SUM(s.subtotal) as total_subtotal,
          SUM(s.tax_amount) as total_tax,
          SUM(s.discount_amount) as total_discount,
          SUM(s.total_amount) as total_sales,
          AVG(s.total_amount) as average_transaction,
          SUM(s.insurance_claim_amount) as total_insurance_claims,
          SUM(s.customer_payment_amount) as total_customer_payments,
          COUNT(DISTINCT s.customer_id) as unique_customers
        FROM sales s
        WHERE ${whereConditions.join(' AND ')}
        GROUP BY ${dateGrouping}
        ORDER BY period ASC
      `;

      const summaryResult = await query(salesSummaryQuery, queryParams);

      // Get payment method breakdown
      const paymentMethodQuery = `
        SELECT 
          s.payment_method,
          COUNT(s.sale_id) as transaction_count,
          SUM(s.total_amount) as total_amount
        FROM sales s
        WHERE ${whereConditions.join(' AND ')}
        GROUP BY s.payment_method
        ORDER BY total_amount DESC
      `;

      const paymentMethodResult = await query(paymentMethodQuery, queryParams);

      // Get top selling products for the period
      const topProductsQuery = `
        SELECT 
          p.product_code,
          p.product_name,
          p.brand_name,
          SUM(si.quantity) as total_quantity_sold,
          SUM(si.line_total) as total_revenue
        FROM sale_items si
        JOIN sales s ON si.sale_id = s.sale_id
        JOIN products p ON si.product_id = p.product_id
        WHERE ${whereConditions.join(' AND ')}
        GROUP BY p.product_id, p.product_code, p.product_name, p.brand_name
        ORDER BY total_revenue DESC
        LIMIT 10
      `;

      const topProductsResult = await query(topProductsQuery, queryParams);

      // Calculate totals for the entire period
      const totalSales = summaryResult.rows.reduce((sum, row) => sum + parseFloat(row.total_sales || 0), 0);
      const totalTransactions = summaryResult.rows.reduce((sum, row) => sum + parseInt(row.total_transactions || 0), 0);

      res.json({
        success: true,
        data: {
          summary: {
            dateRange: { startDate, endDate },
            groupBy,
            totalSales: totalSales.toFixed(2),
            totalTransactions,
            averageTransaction: totalTransactions > 0 ? (totalSales / totalTransactions).toFixed(2) : '0.00'
          },
          periodicData: summaryResult.rows.map(row => ({
            period: row.period,
            totalTransactions: parseInt(row.total_transactions),
            totalSubtotal: parseFloat(row.total_subtotal || 0).toFixed(2),
            totalTax: parseFloat(row.total_tax || 0).toFixed(2),
            totalDiscount: parseFloat(row.total_discount || 0).toFixed(2),
            totalSales: parseFloat(row.total_sales || 0).toFixed(2),
            averageTransaction: parseFloat(row.average_transaction || 0).toFixed(2),
            totalInsuranceClaims: parseFloat(row.total_insurance_claims || 0).toFixed(2),
            totalCustomerPayments: parseFloat(row.total_customer_payments || 0).toFixed(2),
            uniqueCustomers: parseInt(row.unique_customers)
          })),
          paymentMethods: paymentMethodResult.rows.map(row => ({
            method: row.payment_method,
            transactionCount: parseInt(row.transaction_count),
            totalAmount: parseFloat(row.total_amount || 0).toFixed(2)
          })),
          topProducts: topProductsResult.rows.map(row => ({
            productCode: row.product_code,
            productName: row.product_name,
            brandName: row.brand_name,
            quantitySold: parseInt(row.total_quantity_sold),
            revenue: parseFloat(row.total_revenue || 0).toFixed(2)
          }))
        }
      });

    } catch (error) {
      logger.error('Sales summary report error:', error.message);
      res.status(500).json({
        success: false,
        message: 'Failed to generate sales summary report'
      });
    }
  }

  /**
   * Get inventory valuation report
   */
  static async getInventoryValuation(req, res) {
    try {
      const { categoryId, supplierId, includeExpired = 'false' } = req.query;

      let whereConditions = ['i.quantity_on_hand > 0'];
      let queryParams = [];
      let paramIndex = 1;

      if (includeExpired === 'false') {
        whereConditions.push('i.status = \'active\'');
      }

      if (categoryId) {
        whereConditions.push(`p.category_id = $${paramIndex}`);
        queryParams.push(categoryId);
        paramIndex++;
      }

      if (supplierId) {
        whereConditions.push(`i.supplier_id = $${paramIndex}`);
        queryParams.push(supplierId);
        paramIndex++;
      }

      const inventoryValuationQuery = `
        SELECT 
          p.product_id,
          p.product_code,
          p.product_name,
          p.brand_name,
          c.category_name,
          s.supplier_name,
          SUM(i.quantity_on_hand) as total_quantity,
          SUM(i.quantity_reserved) as total_reserved,
          SUM(i.quantity_available) as total_available,
          AVG(i.unit_cost) as average_cost,
          SUM(i.quantity_on_hand * i.unit_cost) as total_value,
          COUNT(DISTINCT i.inventory_id) as batch_count,
          MIN(CASE WHEN i.status = 'active' THEN i.expiration_date END) as nearest_expiration,
          COUNT(CASE WHEN i.expiration_date < CURRENT_DATE THEN 1 END) as expired_batches,
          SUM(CASE WHEN i.expiration_date < CURRENT_DATE THEN i.quantity_on_hand * i.unit_cost ELSE 0 END) as expired_value
        FROM inventory i
        JOIN products p ON i.product_id = p.product_id
        LEFT JOIN categories c ON p.category_id = c.category_id
        LEFT JOIN suppliers s ON i.supplier_id = s.supplier_id
        WHERE ${whereConditions.join(' AND ')}
        GROUP BY p.product_id, p.product_code, p.product_name, p.brand_name, c.category_name, s.supplier_name
        ORDER BY total_value DESC
      `;

      const result = await query(inventoryValuationQuery, queryParams);

      // Calculate summary statistics
      const totalInventoryValue = result.rows.reduce((sum, row) => sum + parseFloat(row.total_value || 0), 0);
      const totalExpiredValue = result.rows.reduce((sum, row) => sum + parseFloat(row.expired_value || 0), 0);
      const totalProducts = result.rows.length;

      // Get category breakdown
      const categoryBreakdownQuery = `
        SELECT 
          COALESCE(c.category_name, 'Uncategorized') as category_name,
          COUNT(DISTINCT p.product_id) as product_count,
          SUM(i.quantity_on_hand) as total_quantity,
          SUM(i.quantity_on_hand * i.unit_cost) as total_value
        FROM inventory i
        JOIN products p ON i.product_id = p.product_id
        LEFT JOIN categories c ON p.category_id = c.category_id
        WHERE ${whereConditions.join(' AND ')}
        GROUP BY c.category_name
        ORDER BY total_value DESC
      `;

      const categoryResult = await query(categoryBreakdownQuery, queryParams);

      res.json({
        success: true,
        data: {
          summary: {
            totalInventoryValue: totalInventoryValue.toFixed(2),
            totalExpiredValue: totalExpiredValue.toFixed(2),
            totalProducts,
            expiredValuePercentage: totalInventoryValue > 0 ? ((totalExpiredValue / totalInventoryValue) * 100).toFixed(2) : '0.00'
          },
          products: result.rows.map(row => ({
            productId: row.product_id,
            productCode: row.product_code,
            productName: row.product_name,
            brandName: row.brand_name,
            categoryName: row.category_name,
            supplierName: row.supplier_name,
            totalQuantity: parseInt(row.total_quantity),
            totalReserved: parseInt(row.total_reserved),
            totalAvailable: parseInt(row.total_available),
            averageCost: parseFloat(row.average_cost || 0).toFixed(2),
            totalValue: parseFloat(row.total_value || 0).toFixed(2),
            batchCount: parseInt(row.batch_count),
            nearestExpiration: row.nearest_expiration,
            expiredBatches: parseInt(row.expired_batches),
            expiredValue: parseFloat(row.expired_value || 0).toFixed(2)
          })),
          categoryBreakdown: categoryResult.rows.map(row => ({
            categoryName: row.category_name,
            productCount: parseInt(row.product_count),
            totalQuantity: parseInt(row.total_quantity),
            totalValue: parseFloat(row.total_value || 0).toFixed(2)
          }))
        }
      });

    } catch (error) {
      logger.error('Inventory valuation report error:', error.message);
      res.status(500).json({
        success: false,
        message: 'Failed to generate inventory valuation report'
      });
    }
  }

  /**
   * Get expiration report
   */
  static async getExpirationReport(req, res) {
    try {
      const { 
        days = 90, 
        urgencyLevel, // critical, warning, watch, expired
        categoryId,
        sortBy = 'expiration_date' // expiration_date, value_at_risk, quantity
      } = req.query;

      let whereConditions = [
        'i.status = \'active\'',
        'i.quantity_on_hand > 0',
        `i.expiration_date <= CURRENT_DATE + INTERVAL '${parseInt(days)} days'`
      ];
      let queryParams = [];
      let paramIndex = 1;

      if (urgencyLevel) {
        switch (urgencyLevel) {
          case 'expired':
            whereConditions.push('i.expiration_date < CURRENT_DATE');
            break;
          case 'critical':
            whereConditions.push('i.expiration_date >= CURRENT_DATE');
            whereConditions.push('i.expiration_date <= CURRENT_DATE + INTERVAL \'30 days\'');
            break;
          case 'warning':
            whereConditions.push('i.expiration_date > CURRENT_DATE + INTERVAL \'30 days\'');
            whereConditions.push('i.expiration_date <= CURRENT_DATE + INTERVAL \'60 days\'');
            break;
          case 'watch':
            whereConditions.push('i.expiration_date > CURRENT_DATE + INTERVAL \'60 days\'');
            break;
        }
      }

      if (categoryId) {
        whereConditions.push(`p.category_id = $${paramIndex}`);
        queryParams.push(categoryId);
        paramIndex++;
      }

      let orderByClause;
      switch (sortBy) {
        case 'value_at_risk':
          orderByClause = 'value_at_risk DESC';
          break;
        case 'quantity':
          orderByClause = 'i.quantity_on_hand DESC';
          break;
        default:
          orderByClause = 'i.expiration_date ASC';
      }

      const expirationQuery = `
        SELECT 
          i.inventory_id,
          p.product_id,
          p.product_code,
          p.product_name,
          p.brand_name,
          c.category_name,
          s.supplier_name,
          i.batch_number,
          i.lot_number,
          i.quantity_on_hand,
          i.unit_cost,
          i.expiration_date,
          (i.expiration_date - CURRENT_DATE) as days_to_expiry,
          CASE 
            WHEN i.expiration_date < CURRENT_DATE THEN 'expired'
            WHEN (i.expiration_date - CURRENT_DATE) <= 30 THEN 'critical'
            WHEN (i.expiration_date - CURRENT_DATE) <= 60 THEN 'warning'
            ELSE 'watch'
          END as urgency_level,
          (i.quantity_on_hand * i.unit_cost) as value_at_risk,
          i.location,
          i.received_date
        FROM inventory i
        JOIN products p ON i.product_id = p.product_id
        LEFT JOIN categories c ON p.category_id = c.category_id
        LEFT JOIN suppliers s ON i.supplier_id = s.supplier_id
        WHERE ${whereConditions.join(' AND ')}
        ORDER BY ${orderByClause}
      `;

      const result = await query(expirationQuery, queryParams);

      // Calculate summary by urgency level
      const summary = {
        expired: { count: 0, quantity: 0, value: 0 },
        critical: { count: 0, quantity: 0, value: 0 },
        warning: { count: 0, quantity: 0, value: 0 },
        watch: { count: 0, quantity: 0, value: 0 }
      };

      result.rows.forEach(row => {
        const urgency = row.urgency_level;
        summary[urgency].count += 1;
        summary[urgency].quantity += parseInt(row.quantity_on_hand);
        summary[urgency].value += parseFloat(row.value_at_risk || 0);
      });

      res.json({
        success: true,
        data: {
          summary: {
            totalItems: result.rows.length,
            totalQuantityAtRisk: result.rows.reduce((sum, row) => sum + parseInt(row.quantity_on_hand), 0),
            totalValueAtRisk: result.rows.reduce((sum, row) => sum + parseFloat(row.value_at_risk || 0), 0).toFixed(2),
            urgencyBreakdown: {
              expired: {
                count: summary.expired.count,
                quantity: summary.expired.quantity,
                value: summary.expired.value.toFixed(2)
              },
              critical: {
                count: summary.critical.count,
                quantity: summary.critical.quantity,
                value: summary.critical.value.toFixed(2)
              },
              warning: {
                count: summary.warning.count,
                quantity: summary.warning.quantity,
                value: summary.warning.value.toFixed(2)
              },
              watch: {
                count: summary.watch.count,
                quantity: summary.watch.quantity,
                value: summary.watch.value.toFixed(2)
              }
            }
          },
          items: result.rows.map(row => ({
            inventoryId: row.inventory_id,
            productId: row.product_id,
            productCode: row.product_code,
            productName: row.product_name,
            brandName: row.brand_name,
            categoryName: row.category_name,
            supplierName: row.supplier_name,
            batchNumber: row.batch_number,
            lotNumber: row.lot_number,
            quantityOnHand: parseInt(row.quantity_on_hand),
            unitCost: parseFloat(row.unit_cost || 0).toFixed(2),
            expirationDate: row.expiration_date,
            daysToExpiry: parseInt(row.days_to_expiry),
            urgencyLevel: row.urgency_level,
            valueAtRisk: parseFloat(row.value_at_risk || 0).toFixed(2),
            location: row.location,
            receivedDate: row.received_date
          }))
        }
      });

    } catch (error) {
      logger.error('Expiration report error:', error.message);
      res.status(500).json({
        success: false,
        message: 'Failed to generate expiration report'
      });
    }
  }

  /**
   * Get low stock report
   */
  static async getLowStockReport(req, res) {
    try {
      const { categoryId, criticalOnly = 'false' } = req.query;

      let whereConditions = ['p.is_active = TRUE'];
      let queryParams = [];
      let paramIndex = 1;

      if (categoryId) {
        whereConditions.push(`p.category_id = $${paramIndex}`);
        queryParams.push(categoryId);
        paramIndex++;
      }

      const lowStockQuery = `
        SELECT 
          p.product_id,
          p.product_code,
          p.product_name,
          p.brand_name,
          c.category_name,
          COALESCE(SUM(i.quantity_on_hand), 0) as total_quantity,
          COALESCE(SUM(i.quantity_reserved), 0) as total_reserved,
          COALESCE(SUM(i.quantity_available), 0) as total_available,
          p.minimum_stock_level,
          p.reorder_point,
          p.maximum_stock_level,
          (p.minimum_stock_level - COALESCE(SUM(i.quantity_available), 0)) as shortage_quantity,
          CASE 
            WHEN COALESCE(SUM(i.quantity_available), 0) <= 0 THEN 'out_of_stock'
            WHEN COALESCE(SUM(i.quantity_available), 0) <= ${config.pharmacy.criticalStockThreshold} THEN 'critical'
            WHEN COALESCE(SUM(i.quantity_available), 0) <= p.minimum_stock_level THEN 'low'
            WHEN COALESCE(SUM(i.quantity_available), 0) <= p.reorder_point THEN 'reorder'
            ELSE 'normal'
          END as stock_status,
          p.unit_cost,
          p.selling_price,
          COUNT(DISTINCT i.inventory_id) FILTER (WHERE i.status = 'active' AND i.quantity_on_hand > 0) as active_batches,
          MIN(CASE WHEN i.status = 'active' AND i.quantity_on_hand > 0 THEN i.expiration_date END) as nearest_expiration
        FROM products p
        LEFT JOIN inventory i ON i.product_id = p.product_id AND i.status = 'active'
        LEFT JOIN categories c ON p.category_id = c.category_id
        WHERE ${whereConditions.join(' AND ')}
        GROUP BY p.product_id, p.product_code, p.product_name, p.brand_name, c.category_name, 
                 p.minimum_stock_level, p.reorder_point, p.maximum_stock_level, p.unit_cost, p.selling_price
        HAVING 
          ${criticalOnly === 'true' 
            ? 'COALESCE(SUM(i.quantity_available), 0) <= 5' 
            : 'COALESCE(SUM(i.quantity_available), 0) <= p.minimum_stock_level'
          }
        ORDER BY shortage_quantity DESC, total_available ASC
      `;

      const result = await query(lowStockQuery, queryParams);

      // Calculate summary statistics
      const summary = {
        outOfStock: 0,
        critical: 0,
        low: 0,
        reorder: 0
      };

      result.rows.forEach(row => {
        switch (row.stock_status) {
          case 'out_of_stock':
            summary.outOfStock += 1;
            break;
          case 'critical':
            summary.critical += 1;
            break;
          case 'low':
            summary.low += 1;
            break;
          case 'reorder':
            summary.reorder += 1;
            break;
        }
      });

      const totalValue = result.rows.reduce((sum, row) => {
        return sum + (parseInt(row.shortage_quantity) * parseFloat(row.unit_cost || 0));
      }, 0);

      res.json({
        success: true,
        data: {
          summary: {
            totalProducts: result.rows.length,
            outOfStock: summary.outOfStock,
            critical: summary.critical,
            low: summary.low,
            reorder: summary.reorder,
            estimatedRestockValue: totalValue.toFixed(2)
          },
          products: result.rows.map(row => ({
            productId: row.product_id,
            productCode: row.product_code,
            productName: row.product_name,
            brandName: row.brand_name,
            categoryName: row.category_name,
            totalQuantity: parseInt(row.total_quantity),
            totalReserved: parseInt(row.total_reserved),
            totalAvailable: parseInt(row.total_available),
            minimumStockLevel: parseInt(row.minimum_stock_level),
            reorderPoint: parseInt(row.reorder_point),
            maximumStockLevel: row.maximum_stock_level ? parseInt(row.maximum_stock_level) : null,
            shortageQuantity: parseInt(row.shortage_quantity),
            stockStatus: row.stock_status,
            unitCost: parseFloat(row.unit_cost || 0).toFixed(2),
            sellingPrice: parseFloat(row.selling_price || 0).toFixed(2),
            activeBatches: parseInt(row.active_batches),
            nearestExpiration: row.nearest_expiration,
            restockValue: (parseInt(row.shortage_quantity) * parseFloat(row.unit_cost || 0)).toFixed(2)
          }))
        }
      });

    } catch (error) {
      logger.error('Low stock report error:', error.message);
      res.status(500).json({
        success: false,
        message: 'Failed to generate low stock report'
      });
    }
  }

  /**
   * Generate custom report based on provided parameters
   */
  static async generateCustomReport(req, res) {
    try {
      const {
        reportType, // sales, inventory, customers, suppliers
        metrics, // array of metrics to include
        filters, // object with filter conditions
        groupBy, // grouping field
        dateRange, // { startDate, endDate }
        sortBy = 'created_at',
        sortOrder = 'DESC',
        limit = 1000
      } = req.body;

      if (!reportType || !metrics || metrics.length === 0) {
        return res.status(400).json({
          success: false,
          message: 'Report type and metrics are required'
        });
      }

      // This is a simplified custom report generator
      // In a production system, you'd want more sophisticated query building
      let baseQuery = '';
      let whereConditions = [];
      let queryParams = [];
      let paramIndex = 1;

      switch (reportType) {
        case 'sales':
          baseQuery = `
            SELECT s.*, c.first_name, c.last_name, u.username as cashier_name
            FROM sales s
            LEFT JOIN customers c ON s.customer_id = c.customer_id
            LEFT JOIN users u ON s.cashier_id = u.user_id
          `;
          
          if (dateRange && dateRange.startDate && dateRange.endDate) {
            whereConditions.push(`s.sale_date >= $${paramIndex}`);
            queryParams.push(dateRange.startDate);
            paramIndex++;
            whereConditions.push(`s.sale_date <= $${paramIndex}`);
            queryParams.push(dateRange.endDate);
            paramIndex++;
          }
          break;

        case 'inventory':
          baseQuery = `
            SELECT i.*, p.product_name, p.product_code, c.category_name, s.supplier_name
            FROM inventory i
            JOIN products p ON i.product_id = p.product_id
            LEFT JOIN categories c ON p.category_id = c.category_id
            LEFT JOIN suppliers s ON i.supplier_id = s.supplier_id
          `;
          
          whereConditions.push('i.quantity_on_hand > 0');
          break;

        default:
          return res.status(400).json({
            success: false,
            message: 'Unsupported report type'
          });
      }

      // Apply filters
      if (filters && typeof filters === 'object') {
        Object.entries(filters).forEach(([key, value]) => {
          if (value !== null && value !== undefined && value !== '') {
            whereConditions.push(`${key} = $${paramIndex}`);
            queryParams.push(value);
            paramIndex++;
          }
        });
      }

      // Build final query
      let finalQuery = baseQuery;
      if (whereConditions.length > 0) {
        finalQuery += ` WHERE ${whereConditions.join(' AND ')}`;
      }
      finalQuery += ` ORDER BY ${sortBy} ${sortOrder} LIMIT ${parseInt(limit)}`;

      const result = await query(finalQuery, queryParams);

      logger.info('Custom report generated', {
        reportType,
        recordCount: result.rows.length,
        userId: req.user.userId
      });

      res.json({
        success: true,
        data: {
          reportType,
          metrics,
          recordCount: result.rows.length,
          generatedAt: new Date().toISOString(),
          data: result.rows
        }
      });

    } catch (error) {
      logger.error('Custom report generation error:', error.message);
      res.status(500).json({
        success: false,
        message: 'Failed to generate custom report'
      });
    }
  }
}

module.exports = ReportController;
