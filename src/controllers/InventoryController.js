// controllers/inventoryController.js
const Inventory = require('../models/Inventory');
const Product = require('../models/Product');
const { validateInventoryData, validatePagination } = require('../utils/validation');
const { handleError, ApiError } = require('../utils/errorHandler');
const logger = require('../utils/logger');

class InventoryController {
    // Create new inventory record
    static async createInventory(req, res, next) {
        try {
            const validatedData = validateInventoryData(req.body);
            
            // Verify product exists
            const product = await Product.findById(validatedData.product_id);
            if (!product) {
                throw new ApiError('Product not found', 404);
            }

            const inventory = await Inventory.create(validatedData);
            
            logger.info(`Inventory created: ${inventory.inventory_id}`, {
                userId: req.user?.user_id,
                productId: inventory.product_id,
                quantity: inventory.quantity_on_hand
            });

            res.status(201).json({
                success: true,
                message: 'Inventory record created successfully',
                data: inventory
            });
        } catch (error) {
            next(error);
        }
    }

    // Get all inventory
    static async getAllInventory(req, res, next) {
        try {
            const pagination = validatePagination(req.query);
            const filters = {
                product_id: req.query.product_id ? parseInt(req.query.product_id) : undefined,
                supplier_id: req.query.supplier_id ? parseInt(req.query.supplier_id) : undefined,
                batch_number: req.query.batch_number,
                location: req.query.location,
                expiry_within_days: req.query.expiry_within_days ? parseInt(req.query.expiry_within_days) : undefined,
                status: req.query.status
            };

            // Remove undefined values
            Object.keys(filters).forEach(key => {
                if (filters[key] === undefined) delete filters[key];
            });

            const result = await Inventory.findAll(filters, pagination);

            res.json({
                success: true,
                data: result.inventory,
                pagination: {
                    currentPage: result.currentPage,
                    totalPages: result.totalPages,
                    totalCount: result.totalCount,
                    limit: pagination.limit
                }
            });
        } catch (error) {
            next(error);
        }
    }

    // Get inventory by ID
    static async getInventoryById(req, res, next) {
        try {
            const { id } = req.params;
            const inventoryId = parseInt(id);

            if (!inventoryId || inventoryId <= 0) {
                throw new ApiError('Invalid inventory ID', 400);
            }

            const inventory = await Inventory.findById(inventoryId);
            if (!inventory) {
                throw new ApiError('Inventory record not found', 404);
            }

            res.json({
                success: true,
                data: inventory
            });
        } catch (error) {
            next(error);
        }
    }

    // Update inventory quantity
    static async updateInventoryQuantity(req, res, next) {
        try {
            const { id } = req.params;
            const { quantity, reason } = req.body;
            const inventoryId = parseInt(id);

            if (!inventoryId || inventoryId <= 0) {
                throw new ApiError('Invalid inventory ID', 400);
            }

            if (typeof quantity !== 'number' || quantity < 0) {
                throw new ApiError('Quantity must be a non-negative number', 400);
            }

            const updatedInventory = await Inventory.updateQuantity(inventoryId, quantity, reason);

            logger.info(`Inventory quantity updated: ${inventoryId}`, {
                userId: req.user?.user_id,
                newQuantity: quantity,
                reason: reason
            });

            res.json({
                success: true,
                message: 'Inventory quantity updated successfully',
                data: updatedInventory
            });
        } catch (error) {
            next(error);
        }
    }

    // Reserve inventory
    static async reserveInventory(req, res, next) {
        try {
            const { id } = req.params;
            const { quantity } = req.body;
            const inventoryId = parseInt(id);

            if (!inventoryId || inventoryId <= 0) {
                throw new ApiError('Invalid inventory ID', 400);
            }

            if (!quantity || quantity <= 0) {
                throw new ApiError('Quantity must be a positive number', 400);
            }

            const reservedInventory = await Inventory.reserveQuantity(inventoryId, quantity);

            logger.info(`Inventory reserved: ${inventoryId}`, {
                userId: req.user?.user_id,
                reservedQuantity: quantity
            });

            res.json({
                success: true,
                message: 'Inventory reserved successfully',
                data: reservedInventory
            });
        } catch (error) {
            next(error);
        }
    }

    // Release reserved inventory
    static async releaseReservedInventory(req, res, next) {
        try {
            const { id } = req.params;
            const { quantity } = req.body;
            const inventoryId = parseInt(id);

            if (!inventoryId || inventoryId <= 0) {
                throw new ApiError('Invalid inventory ID', 400);
            }

            if (!quantity || quantity <= 0) {
                throw new ApiError('Quantity must be a positive number', 400);
            }

            const updatedInventory = await Inventory.releaseReservedQuantity(inventoryId, quantity);

            logger.info(`Reserved inventory released: ${inventoryId}`, {
                userId: req.user?.user_id,
                releasedQuantity: quantity
            });

            res.json({
                success: true,
                message: 'Reserved inventory released successfully',
                data: updatedInventory
            });
        } catch (error) {
            next(error);
        }
    }

    // Get stock level for a product
    static async getStockLevel(req, res, next) {
        try {
            const { productId } = req.params;
            const id = parseInt(productId);

            if (!id || id <= 0) {
                throw new ApiError('Invalid product ID', 400);
            }

            const stockLevel = await Inventory.getStockLevel(id);
            if (!stockLevel) {
                throw new ApiError('Product not found', 404);
            }

            res.json({
                success: true,
                data: stockLevel
            });
        } catch (error) {
            next(error);
        }
    }

    // Get expiring inventory
    static async getExpiringInventory(req, res, next) {
        try {
            const daysAhead = req.query.days ? parseInt(req.query.days) : 90;
            
            if (daysAhead < 1 || daysAhead > 365) {
                throw new ApiError('Days ahead must be between 1 and 365', 400);
            }

            const expiringInventory = await Inventory.getExpiringInventory(daysAhead);

            res.json({
                success: true,
                data: expiringInventory,
                meta: {
                    daysAhead: daysAhead,
                    totalItems: expiringInventory.length
                }
            });
        } catch (error) {
            next(error);
        }
    }

    // Get low stock products
    static async getLowStockProducts(req, res, next) {
        try {
            const lowStockProducts = await Inventory.getLowStockProducts();

            res.json({
                success: true,
                data: lowStockProducts,
                meta: {
                    totalItems: lowStockProducts.length
                }
            });
        } catch (error) {
            next(error);
        }
    }

    // Update inventory status
    static async updateInventoryStatus(req, res, next) {
        try {
            const { id } = req.params;
            const { status, reason } = req.body;
            const inventoryId = parseInt(id);

            if (!inventoryId || inventoryId <= 0) {
                throw new ApiError('Invalid inventory ID', 400);
            }

            const validStatuses = ['active', 'expired', 'damaged', 'recalled'];
            if (!validStatuses.includes(status)) {
                throw new ApiError(`Status must be one of: ${validStatuses.join(', ')}`, 400);
            }

            const updatedInventory = await Inventory.updateStatus(inventoryId, status, reason);

            logger.info(`Inventory status updated: ${inventoryId}`, {
                userId: req.user?.user_id,
                newStatus: status,
                reason: reason
            });

            res.json({
                success: true,
                message: 'Inventory status updated successfully',
                data: updatedInventory
            });
        } catch (error) {
            next(error);
        }
    }

    // Get movement history
    static async getMovementHistory(req, res, next) {
        try {
            const { id } = req.params;
            const inventoryId = parseInt(id);

            if (!inventoryId || inventoryId <= 0) {
                throw new ApiError('Invalid inventory ID', 400);
            }

            const movements = await Inventory.getMovementHistory(inventoryId);

            res.json({
                success: true,
                data: movements,
                meta: {
                    totalMovements: movements.length
                }
            });
        } catch (error) {
            next(error);
        }
    }

    // Bulk update inventory quantities
    static async bulkUpdateQuantities(req, res, next) {
        try {
            const { updates } = req.body;

            if (!Array.isArray(updates) || updates.length === 0) {
                throw new ApiError('Updates array is required', 400);
            }

            if (updates.length > 100) {
                throw new ApiError('Cannot update more than 100 inventory records at once', 400);
            }

            // Validate all updates
            const validatedUpdates = updates.map((update, index) => {
                const { inventory_id, new_quantity, reason } = update;

                if (!inventory_id || inventory_id <= 0) {
                    throw new ApiError(`Update at index ${index}: Invalid inventory ID`, 400);
                }

                if (typeof new_quantity !== 'number' || new_quantity < 0) {
                    throw new ApiError(`Update at index ${index}: Quantity must be a non-negative number`, 400);
                }

                return { inventory_id, new_quantity, reason: reason || 'Bulk update' };
            });

            const updatedInventory = await Inventory.bulkUpdateQuantities(validatedUpdates);

            logger.info(`Bulk updated ${updatedInventory.length} inventory records`, {
                userId: req.user?.user_id,
                count: updatedInventory.length
            });

            res.json({
                success: true,
                message: `${updatedInventory.length} inventory records updated successfully`,
                data: updatedInventory
            });
        } catch (error) {
            next(error);
        }
    }

    // Inventory adjustment
    static async inventoryAdjustment(req, res, next) {
        try {
            const { id } = req.params;
            const { adjustment_quantity, reason } = req.body;
            const inventoryId = parseInt(id);

            if (!inventoryId || inventoryId <= 0) {
                throw new ApiError('Invalid inventory ID', 400);
            }

            if (typeof adjustment_quantity !== 'number') {
                throw new ApiError('Adjustment quantity must be a number', 400);
            }

            if (!reason || reason.trim().length === 0) {
                throw new ApiError('Reason is required for inventory adjustments', 400);
            }

            // Get current inventory
            const currentInventory = await Inventory.findById(inventoryId);
            if (!currentInventory) {
                throw new ApiError('Inventory record not found', 404);
            }

            const newQuantity = Math.max(0, currentInventory.quantity_on_hand + adjustment_quantity);
            const updatedInventory = await Inventory.updateQuantity(inventoryId, newQuantity, reason);

            logger.info(`Inventory adjustment: ${inventoryId}`, {
                userId: req.user?.user_id,
                adjustmentQuantity: adjustment_quantity,
                newQuantity: newQuantity,
                reason: reason
            });

            res.json({
                success: true,
                message: 'Inventory adjustment completed successfully',
                data: {
                    ...updatedInventory,
                    adjustment_made: adjustment_quantity,
                    previous_quantity: currentInventory.quantity_on_hand
                }
            });
        } catch (error) {
            next(error);
        }
    }
}

module.exports = InventoryController;
