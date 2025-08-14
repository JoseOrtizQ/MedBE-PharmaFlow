const { query, transaction } = require('../config/database');
const config = require('../config/environment');
const logger = require('../utils/logger');

class StockMovementController {
  /**
   * Get stock movements with filtering and pagination
   */
  static async getMovements(req, res) {
    try {
      const {
        productId,
        inventoryId,
        movementType,
        startDate,
        endDate,
        performedBy,
        page = 1,
        limit = 50,
        sortBy = 'movement_date',
        sortOrder = 'DESC'
      } = req.query;

      const offset = (parseInt(page) - 1) * parseInt(limit);
      let whereConditions = [];
      let queryParams = [];
      let paramIndex = 1;

      // Build WHERE conditions
      if (productId) {
        whereConditions.push(`sm.product_id = $${paramIndex}`);
        queryParams.push(productId);
        paramIndex++;
      }

      if (inventoryId) {
        whereConditions.push(`sm.inventory_id = $${paramIndex}`);
        queryParams.push(inventoryId);
        paramIndex++;
      }

      if (movementType) {
        whereConditions.push(`sm.movement_type = $${paramIndex}`);
        queryParams.push(movementType);
        paramIndex++;
      }

      if (startDate) {
        whereConditions.push(`sm.movement_date >= $${paramIndex}`);
        queryParams.push(startDate);
        paramIndex++;
      }

      if (endDate) {
        whereConditions.push(`sm.movement_date <= $${paramIndex}`);
        queryParams.push(endDate);
        paramIndex++;
      }

      if (performedBy) {
        whereConditions.push(`sm.performed_by = $${paramIndex}`);
        queryParams.push(performedBy);
        paramIndex++;
      }

      const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';

      // Get total count for pagination
      const countQuery = `
        SELECT COUNT(*) as total
        FROM stock_movements sm
        ${whereClause}
      `;
      const countResult = await query(countQuery, queryParams);
      const totalRecords = parseInt(countResult.rows[0].total);

      // Get movements with product and user details
      const movementsQuery = `
        SELECT 
          sm.movement_id,
          sm.inventory_id,
          sm.product_id,
          sm.movement_type,
          sm.quantity_change,
          sm.quantity_before,
          sm.quantity_after,
          sm.reference_id,
          sm.reference_type,
          sm.unit_cost,
          sm.reason,
          sm.movement_date,
          p.product_code,
          p.product_name,
          p.brand_name,
          u.username as performed_by_username,
          u.first_name as performed_by_first_name,
          u.last_name as performed_by_last_name,
          i.batch_number,
          i.expiration_date
        FROM stock_movements sm
        JOIN products p ON sm.product_id = p.product_id
        LEFT JOIN users u ON sm.performed_by = u.user_id
        LEFT JOIN inventory i ON sm.inventory_id = i.inventory_id
        ${whereClause}
        ORDER BY ${sortBy} ${sortOrder}
        LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
      `;

      queryParams.push(parseInt(limit), offset);
      const result = await query(movementsQuery, queryParams);

      const totalPages = Math.ceil(totalRecords / parseInt(limit));

      res.json({
        success: true,
        data: {
          movements: result.rows.map(row => ({
            movementId: row.movement_id,
            inventoryId: row.inventory_id,
            productId: row.product_id,
            productCode: row.product_code,
            productName: row.product_name,
            brandName: row.brand_name,
            batchNumber: row.batch_number,
            expirationDate: row.expiration_date,
            movementType: row.movement_type,
            quantityChange: parseInt(row.quantity_change),
            quantityBefore: parseInt(row.quantity_before),
            quantityAfter: parseInt(row.quantity_after),
            referenceId: row.reference_id,
            referenceType: row.reference_type,
            unitCost: row.unit_cost ? parseFloat(row.unit_cost).toFixed(2) : null,
            reason: row.reason,
            movementDate: row.movement_date,
            performedBy: row.performed_by_username ? {
              username: row.performed_by_username,
              firstName: row.performed_by_first_name,
              lastName: row.performed_by_last_name
            } : null
          })),
          pagination: {
            currentPage: parseInt(page),
            totalPages,
            totalRecords,
            hasNextPage: parseInt(page) < totalPages,
            hasPrevPage: parseInt(page) > 1
          }
        }
      });

    } catch (error) {
      logger.error('Get stock movements error:', error.message);
      res.status(500).json({
        success: false,
        message: 'Failed to retrieve stock movements'
      });
    }
  }

  /**
   * Get movement history for a specific product
   */
  static async getProductMovementHistory(req, res) {
    try {
      const { productId } = req.params;
      const { limit = 100, days = 30 } = req.query;

      if (!productId) {
        return res.status(400).json({
          success: false,
          message: 'Product ID is required'
        });
      }

      const historyQuery = `
        SELECT 
          sm.movement_id,
          sm.inventory_id,
          sm.movement_type,
          sm.quantity_change,
          sm.quantity_before,
          sm.quantity_after,
          sm.reference_id,
          sm.reference_type,
          sm.unit_cost,
          sm.reason,
          sm.movement_date,
          u.username as performed_by_username,
          i.batch_number,
          i.expiration_date
        FROM stock_movements sm
        LEFT JOIN users u ON sm.performed_by = u.user_id
        LEFT JOIN inventory i ON sm.inventory_id = i.inventory_id
        WHERE sm.product_id = $1 
        AND sm.movement_date >= CURRENT_DATE - INTERVAL '${parseInt(days)} days'
        ORDER BY sm.movement_date DESC
        LIMIT $2
      `;

      const result = await query(historyQuery, [productId, parseInt(limit)]);

      // Get current stock level
      const currentStockQuery = `
        SELECT 
          SUM(quantity_on_hand) as total_quantity,
          COUNT(DISTINCT inventory_id) as batch_count
        FROM inventory 
        WHERE product_id = $1 AND status = 'active'
      `;
      
      const stockResult = await query(currentStockQuery, [productId]);
      const currentStock = stockResult.rows[0];

      res.json({
        success: true,
        data: {
          productId: parseInt(productId),
          currentStock: {
            totalQuantity: parseInt(currentStock.total_quantity || 0),
            batchCount: parseInt(currentStock.batch_count || 0)
          },
          movements: result.rows.map(row => ({
            movementId: row.movement_id,
            inventoryId: row.inventory_id,
            batchNumber: row.batch_number,
            expirationDate: row.expiration_date,
            movementType: row.movement_type,
            quantityChange: parseInt(row.quantity_change),
            quantityBefore: parseInt(row.quantity_before),
            quantityAfter: parseInt(row.quantity_after),
            referenceId: row.reference_id,
            referenceType: row.reference_type,
            unitCost: row.unit_cost ? parseFloat(row.unit_cost).toFixed(2) : null,
            reason: row.reason,
            movementDate: row.movement_date,
            performedBy: row.performed_by_username
          }))
        }
      });

    } catch (error) {
      logger.error('Get product movement history error:', error.message);
      res.status(500).json({
        success: false,
        message: 'Failed to retrieve product movement history'
      });
    }
  }

  /**
   * Create manual stock adjustment
   */
  static async createAdjustment(req, res) {
    try {
      const {
        inventoryId,
        adjustmentType = 'adjustment', // adjustment, damaged, expired, return
        quantityChange,
        reason,
        unitCost
      } = req.body;

      const userId = req.user.userId;

      // Input validation
      if (!inventoryId || !quantityChange || quantityChange === 0) {
        return res.status(400).json({
          success: false,
          message: 'Inventory ID and non-zero quantity change are required'
        });
      }

      if (!reason || reason.trim().length === 0) {
        return res.status(400).json({
          success: false,
          message: 'Reason for adjustment is required'
        });
      }

      await transaction(async (client) => {
        // Get current inventory details
        const inventoryQuery = `
          SELECT i.*, p.product_name, p.product_code
          FROM inventory i
          JOIN products p ON i.product_id = p.product_id
          WHERE i.inventory_id = $1 AND i.status = 'active'
          FOR UPDATE
        `;
        
        const inventoryResult = await client.query(inventoryQuery, [inventoryId]);

        if (inventoryResult.rows.length === 0) {
          throw new Error('Inventory record not found or inactive');
        }

        const inventory = inventoryResult.rows[0];
        const quantityBefore = parseInt(inventory.quantity_on_hand);
        const quantityAfter = quantityBefore + parseInt(quantityChange);

        // Validate that quantity won't go negative
        if (quantityAfter < 0) {
          throw new Error(`Cannot reduce quantity by ${Math.abs(quantityChange)}. Available: ${quantityBefore}`);
        }

        // Update inventory quantity
        const updateInventoryQuery = `
          UPDATE inventory 
          SET 
            quantity_on_hand = $1,
            updated_at = NOW()
          WHERE inventory_id = $2
        `;
        
        await client.query(updateInventoryQuery, [quantityAfter, inventoryId]);

        // Create stock movement record
        const movementQuery = `
          INSERT INTO stock_movements (
            inventory_id, 
            product_id, 
            movement_type, 
            quantity_change, 
            quantity_before, 
            quantity_after,
            unit_cost,
            reason,
            performed_by
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          RETURNING movement_id, movement_date
        `;

        const movementResult = await client.query(movementQuery, [
          inventoryId,
          inventory.product_id,
          adjustmentType,
          quantityChange,
          quantityBefore,
          quantityAfter,
          unitCost || inventory.unit_cost,
          reason.trim(),
          userId
        ]);

        const movement = movementResult.rows[0];

        logger.info('Stock adjustment created', {
          movementId: movement.movement_id,
          productCode: inventory.product_code,
          quantityChange: parseInt(quantityChange),
          userId: userId,
          reason: reason.trim()
        });

        res.status(201).json({
          success: true,
          message: 'Stock adjustment created successfully',
          data: {
            movementId: movement.movement_id,
            inventoryId: parseInt(inventoryId),
            productId: inventory.product_id,
            productCode: inventory.product_code,
            productName: inventory.product_name,
            batchNumber: inventory.batch_number,
            movementType: adjustmentType,
            quantityChange: parseInt(quantityChange),
            quantityBefore,
            quantityAfter,
            reason: reason.trim(),
            movementDate: movement.movement_date
          }
        });
      });

    } catch (error) {
      logger.error('Create stock adjustment error:', error.message);
      res.status(400).json({
        success: false,
        message: error.message || 'Failed to create stock adjustment'
      });
    }
  }

  /**
   * Create stock transfer between inventory records
   */
  static async createTransfer(req, res) {
    try {
      const {
        fromInventoryId,
        toInventoryId,
        quantity,
        reason
      } = req.body;

      const userId = req.user.userId;

      // Input validation
      if (!fromInventoryId || !toInventoryId || !quantity || quantity <= 0) {
        return res.status(400).json({
          success: false,
          message: 'From inventory, to inventory, and positive quantity are required'
        });
      }

      if (fromInventoryId === toInventoryId) {
        return res.status(400).json({
          success: false,
          message: 'Cannot transfer to the same inventory record'
        });
      }

      if (!reason || reason.trim().length === 0) {
        return res.status(400).json({
          success: false,
          message: 'Reason for transfer is required'
        });
      }

      await transaction(async (client) => {
        // Get source inventory details
        const fromInventoryQuery = `
          SELECT i.*, p.product_name, p.product_code
          FROM inventory i
          JOIN products p ON i.product_id = p.product_id
          WHERE i.inventory_id = $1 AND i.status = 'active'
          FOR UPDATE
        `;
        
        const fromInventoryResult = await client.query(fromInventoryQuery, [fromInventoryId]);

        if (fromInventoryResult.rows.length === 0) {
          throw new Error('Source inventory record not found or inactive');
        }

        const fromInventory = fromInventoryResult.rows[0];

        // Get destination inventory details
        const toInventoryQuery = `
          SELECT i.*, p.product_name, p.product_code
          FROM inventory i
          JOIN products p ON i.product_id = p.product_id
          WHERE i.inventory_id = $1 AND i.status = 'active'
          FOR UPDATE
        `;
        
        const toInventoryResult = await client.query(toInventoryQuery, [toInventoryId]);

        if (toInventoryResult.rows.length === 0) {
          throw new Error('Destination inventory record not found or inactive');
        }

        const toInventory = toInventoryResult.rows[0];

        // Validate that both records are for the same product
        if (fromInventory.product_id !== toInventory.product_id) {
          throw new Error('Cannot transfer between different products');
        }

        const transferQuantity = parseInt(quantity);
        const fromQuantityBefore = parseInt(fromInventory.quantity_on_hand);
        const toQuantityBefore = parseInt(toInventory.quantity_on_hand);

        // Validate sufficient quantity in source
        if (fromQuantityBefore < transferQuantity) {
          throw new Error(`Insufficient quantity in source batch. Available: ${fromQuantityBefore}`);
        }

        const fromQuantityAfter = fromQuantityBefore - transferQuantity;
        const toQuantityAfter = toQuantityBefore + transferQuantity;

        // Update source inventory
        await client.query(
          'UPDATE inventory SET quantity_on_hand = $1, updated_at = NOW() WHERE inventory_id = $2',
          [fromQuantityAfter, fromInventoryId]
        );

        // Update destination inventory
        await client.query(
          'UPDATE inventory SET quantity_on_hand = $1, updated_at = NOW() WHERE inventory_id = $2',
          [toQuantityAfter, toInventoryId]
        );

        // Create movement record for source (outbound)
        const fromMovementQuery = `
          INSERT INTO stock_movements (
            inventory_id, product_id, movement_type, quantity_change, 
            quantity_before, quantity_after, unit_cost, reason, 
            performed_by, reference_id, reference_type
          ) VALUES ($1, $2, 'transfer', $3, $4, $5, $6, $7, $8, $9, 'transfer_out')
          RETURNING movement_id
        `;

        const fromMovementResult = await client.query(fromMovementQuery, [
          fromInventoryId,
          fromInventory.product_id,
          -transferQuantity,
          fromQuantityBefore,
          fromQuantityAfter,
          fromInventory.unit_cost,
          `Transfer out: ${reason.trim()}`,
          userId,
          toInventoryId
        ]);

        // Create movement record for destination (inbound)
        const toMovementQuery = `
          INSERT INTO stock_movements (
            inventory_id, product_id, movement_type, quantity_change, 
            quantity_before, quantity_after, unit_cost, reason, 
            performed_by, reference_id, reference_type
          ) VALUES ($1, $2, 'transfer', $3, $4, $5, $6, $7, $8, $9, 'transfer_in')
          RETURNING movement_id
        `;

        const toMovementResult = await client.query(toMovementQuery, [
          toInventoryId,
          toInventory.product_id,
          transferQuantity,
          toQuantityBefore,
          toQuantityAfter,
          toInventory.unit_cost,
          `Transfer in: ${reason.trim()}`,
          userId,
          fromInventoryId
        ]);

        logger.info('Stock transfer completed', {
          fromMovementId: fromMovementResult.rows[0].movement_id,
          toMovementId: toMovementResult.rows[0].movement_id,
          productCode: fromInventory.product_code,
          quantity: transferQuantity,
          userId: userId
        });

        res.status(201).json({
          success: true,
          message: 'Stock transfer completed successfully',
          data: {
            transfer: {
              productId: fromInventory.product_id,
              productCode: fromInventory.product_code,
              productName: fromInventory.product_name,
              quantity: transferQuantity,
              reason: reason.trim(),
              from: {
                inventoryId: parseInt(fromInventoryId),
                batchNumber: fromInventory.batch_number,
                quantityBefore: fromQuantityBefore,
                quantityAfter: fromQuantityAfter,
                movementId: fromMovementResult.rows[0].movement_id
              },
              to: {
                inventoryId: parseInt(toInventoryId),
                batchNumber: toInventory.batch_number,
                quantityBefore: toQuantityBefore,
                quantityAfter: toQuantityAfter,
                movementId: toMovementResult.rows[0].movement_id
              }
            }
          }
        });
      });

    } catch (error) {
      logger.error('Create stock transfer error:', error.message);
      res.status(400).json({
        success: false,
        message: error.message || 'Failed to create stock transfer'
      });
    }
  }

  /**
   * Get movement summary statistics
   */
  static async getMovementSummary(req, res) {
    try {
      const { days = 30 } = req.query;

      const summaryQuery = `
        SELECT 
          movement_type,
          COUNT(*) as movement_count,
          SUM(ABS(quantity_change)) as total_quantity,
          AVG(ABS(quantity_change)) as average_quantity
        FROM stock_movements 
        WHERE movement_date >= CURRENT_DATE - INTERVAL '${parseInt(days)} days'
        GROUP BY movement_type
        ORDER BY movement_count DESC
      `;

      const result = await query(summaryQuery);

      // Get recent significant movements
      const recentMovementsQuery = `
        SELECT 
          sm.movement_id,
          sm.movement_type,
          sm.quantity_change,
          sm.movement_date,
          sm.reason,
          p.product_code,
          p.product_name,
          u.username
        FROM stock_movements sm
        JOIN products p ON sm.product_id = p.product_id
        LEFT JOIN users u ON sm.performed_by = u.user_id
        WHERE sm.movement_date >= CURRENT_DATE - INTERVAL '7 days'
        AND ABS(sm.quantity_change) >= 10
        ORDER BY sm.movement_date DESC
        LIMIT 10
      `;

      const recentResult = await query(recentMovementsQuery);

      res.json({
        success: true,
        data: {
          period: `${days} days`,
          summary: result.rows.map(row => ({
            movementType: row.movement_type,
            movementCount: parseInt(row.movement_count),
            totalQuantity: parseInt(row.total_quantity || 0),
            averageQuantity: parseFloat(row.average_quantity || 0).toFixed(2)
          })),
          recentSignificantMovements: recentResult.rows.map(row => ({
            movementId: row.movement_id,
            movementType: row.movement_type,
            quantityChange: parseInt(row.quantity_change),
            movementDate: row.movement_date,
            reason: row.reason,
            productCode: row.product_code,
            productName: row.product_name,
            performedBy: row.username
          }))
        }
      });

    } catch (error) {
      logger.error('Get movement summary error:', error.message);
      res.status(500).json({
        success: false,
        message: 'Failed to retrieve movement summary'
      });
    }
  }
}

module.exports = StockMovementController;
