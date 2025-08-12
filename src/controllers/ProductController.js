const { query, transaction } = require('../config/database');
const config = require('../config/environment');
const logger = require('../utils/logger');
const { generatePagination, generateProductCode } = require('../utils/helpers');

class ProductController {
  /**
   * Get all products with pagination, filtering, and search
   */
  static async getAllProducts(req, res) {
    try {
      const { 
        page = 1, 
        limit = 10, 
        category, 
        isActive, 
        search,
        requiresPrescription,
        controlledSubstance,
        sortBy = 'created_at',
        sortOrder = 'DESC'
      } = req.query;

      // Validate pagination parameters
      const pageNum = Math.max(1, parseInt(page));
      const limitNum = Math.min(100, Math.max(1, parseInt(limit)));
      const offset = (pageNum - 1) * limitNum;

      // Validate sort parameters
      const allowedSortFields = ['product_name', 'brand_name', 'unit_cost', 'selling_price', 'created_at', 'updated_at'];
      const sortField = allowedSortFields.includes(sortBy) ? sortBy : 'created_at';
      const sortDir = sortOrder.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

      // Build WHERE clause
      let whereClause = 'WHERE 1=1';
      const queryParams = [];
      let paramIndex = 1;

      if (category) {
        whereClause += ` AND p.category_id = $${paramIndex}`;
        queryParams.push(category);
        paramIndex++;
      }

      if (isActive !== undefined) {
        whereClause += ` AND p.is_active = $${paramIndex}`;
        queryParams.push(isActive === 'true');
        paramIndex++;
      }

      if (requiresPrescription !== undefined) {
        whereClause += ` AND p.requires_prescription = $${paramIndex}`;
        queryParams.push(requiresPrescription === 'true');
        paramIndex++;
      }

      if (controlledSubstance !== undefined) {
        whereClause += ` AND p.controlled_substance = $${paramIndex}`;
        queryParams.push(controlledSubstance === 'true');
        paramIndex++;
      }

      if (search) {
        whereClause += ` AND (
          p.product_name ILIKE $${paramIndex} OR 
          p.generic_name ILIKE $${paramIndex} OR 
          p.brand_name ILIKE $${paramIndex} OR 
          p.product_code ILIKE $${paramIndex} OR
          p.manufacturer ILIKE $${paramIndex}
        )`;
        queryParams.push(`%${search}%`);
        paramIndex++;
      }

      // Get total count
      const countQuery = `
        SELECT COUNT(*) as total 
        FROM products p
        LEFT JOIN categories c ON p.category_id = c.category_id
        ${whereClause}
      `;
      const countResult = await query(countQuery, queryParams);
      const totalProducts = parseInt(countResult.rows[0].total);

      // Get paginated products
      const productsQuery = `
        SELECT 
          p.product_id, p.product_code, p.product_name, p.generic_name, p.brand_name,
          p.category_id, c.category_name, p.dosage_form, p.strength, p.unit_of_measure,
          p.description, p.manufacturer, p.requires_prescription, p.controlled_substance,
          p.storage_conditions, p.minimum_stock_level, p.maximum_stock_level, p.reorder_point,
          p.unit_cost, p.selling_price, p.markup_percentage, p.tax_rate, p.is_active,
          p.created_at, p.updated_at
        FROM products p
        LEFT JOIN categories c ON p.category_id = c.category_id
        ${whereClause}
        ORDER BY p.${sortField} ${sortDir}
        LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
      `;
      queryParams.push(limitNum, offset);

      const productsResult = await query(productsQuery, queryParams);

      const pagination = generatePagination(pageNum, limitNum, totalProducts);

      res.json({
        success: true,
        data: {
          products: productsResult.rows.map(product => ({
            id: product.product_id,
            productCode: product.product_code,
            productName: product.product_name,
            genericName: product.generic_name,
            brandName: product.brand_name,
            category: {
              id: product.category_id,
              name: product.category_name
            },
            dosageForm: product.dosage_form,
            strength: product.strength,
            unitOfMeasure: product.unit_of_measure,
            description: product.description,
            manufacturer: product.manufacturer,
            requiresPrescription: product.requires_prescription,
            controlledSubstance: product.controlled_substance,
            storageConditions: product.storage_conditions,
            minimumStockLevel: product.minimum_stock_level,
            maximumStockLevel: product.maximum_stock_level,
            reorderPoint: product.reorder_point,
            unitCost: parseFloat(product.unit_cost || 0),
            sellingPrice: parseFloat(product.selling_price || 0),
            markupPercentage: parseFloat(product.markup_percentage || 0),
            taxRate: parseFloat(product.tax_rate || 0),
            isActive: product.is_active,
            createdAt: product.created_at,
            updatedAt: product.updated_at
          })),
          pagination
        }
      });

    } catch (error) {
      logger.error('Get all products error:', error.message);
      res.status(500).json({
        success: false,
        message: 'Failed to retrieve products'
      });
    }
  }

  /**
   * Get product by ID
   */
  static async getProductById(req, res) {
    try {
      const { productId } = req.params;

      if (!productId || isNaN(productId)) {
        return res.status(400).json({
          success: false,
          message: 'Valid product ID is required'
        });
      }

      const productQuery = `
        SELECT 
          p.product_id, p.product_code, p.product_name, p.generic_name, p.brand_name,
          p.category_id, c.category_name, p.dosage_form, p.strength, p.unit_of_measure,
          p.description, p.manufacturer, p.requires_prescription, p.controlled_substance,
          p.storage_conditions, p.minimum_stock_level, p.maximum_stock_level, p.reorder_point,
          p.unit_cost, p.selling_price, p.markup_percentage, p.tax_rate, p.is_active,
          p.created_at, p.updated_at,
          -- Get current inventory levels
          COALESCE(SUM(i.quantity_on_hand), 0) as total_quantity,
          COALESCE(SUM(i.quantity_available), 0) as available_quantity
        FROM products p
        LEFT JOIN categories c ON p.category_id = c.category_id
        LEFT JOIN inventory i ON p.product_id = i.product_id AND i.status = 'active'
        WHERE p.product_id = $1
        GROUP BY p.product_id, c.category_name
      `;
      
      const result = await query(productQuery, [productId]);

      if (result.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'Product not found'
        });
      }

      const product = result.rows[0];

      res.json({
        success: true,
        data: {
          product: {
            id: product.product_id,
            productCode: product.product_code,
            productName: product.product_name,
            genericName: product.generic_name,
            brandName: product.brand_name,
            category: {
              id: product.category_id,
              name: product.category_name
            },
            dosageForm: product.dosage_form,
            strength: product.strength,
            unitOfMeasure: product.unit_of_measure,
            description: product.description,
            manufacturer: product.manufacturer,
            requiresPrescription: product.requires_prescription,
            controlledSubstance: product.controlled_substance,
            storageConditions: product.storage_conditions,
            minimumStockLevel: product.minimum_stock_level,
            maximumStockLevel: product.maximum_stock_level,
            reorderPoint: product.reorder_point,
            unitCost: parseFloat(product.unit_cost || 0),
            sellingPrice: parseFloat(product.selling_price || 0),
            markupPercentage: parseFloat(product.markup_percentage || 0),
            taxRate: parseFloat(product.tax_rate || 0),
            isActive: product.is_active,
            currentStock: {
              totalQuantity: parseInt(product.total_quantity),
              availableQuantity: parseInt(product.available_quantity)
            },
            createdAt: product.created_at,
            updatedAt: product.updated_at
          }
        }
      });

    } catch (error) {
      logger.error('Get product by ID error:', error.message);
      res.status(500).json({
        success: false,
        message: 'Failed to retrieve product'
      });
    }
  }

  /**
   * Create new product
   */
  static async createProduct(req, res) {
    try {
      const {
        productName,
        genericName,
        brandName,
        categoryId,
        dosageForm,
        strength,
        unitOfMeasure = 'pieces',
        description,
        manufacturer,
        requiresPrescription = false,
        controlledSubstance = false,
        storageConditions,
        minimumStockLevel = 0,
        maximumStockLevel,
        reorderPoint = 0,
        unitCost,
        sellingPrice,
        markupPercentage,
        taxRate = config.pharmacy.defaultTaxRate
      } = req.body;

      // Input validation
      if (!productName) {
        return res.status(400).json({
          success: false,
          message: 'Product name is required'
        });
      }

      // Validate numeric fields
      if (unitCost !== undefined && (isNaN(unitCost) || unitCost < 0)) {
        return res.status(400).json({
          success: false,
          message: 'Unit cost must be a valid positive number'
        });
      }

      if (sellingPrice !== undefined && (isNaN(sellingPrice) || sellingPrice < 0)) {
        return res.status(400).json({
          success: false,
          message: 'Selling price must be a valid positive number'
        });
      }

      if (minimumStockLevel < 0 || reorderPoint < 0) {
        return res.status(400).json({
          success: false,
          message: 'Stock levels must be positive numbers'
        });
      }

      if (maximumStockLevel !== undefined && maximumStockLevel < minimumStockLevel) {
        return res.status(400).json({
          success: false,
          message: 'Maximum stock level must be greater than minimum stock level'
        });
      }

      await transaction(async (client) => {
        // Generate unique product code
        const productCode = await generateProductCode(client);

        // Verify category exists if provided
        if (categoryId) {
          const categoryQuery = `SELECT category_id FROM categories WHERE category_id = $1 AND is_active = TRUE`;
          const categoryResult = await client.query(categoryQuery, [categoryId]);
          
          if (categoryResult.rows.length === 0) {
            throw new Error('Invalid or inactive category specified');
          }
        }

        // Calculate markup percentage if not provided
        let calculatedMarkupPercentage = markupPercentage;
        if (!calculatedMarkupPercentage && unitCost && sellingPrice) {
          calculatedMarkupPercentage = ((sellingPrice - unitCost) / unitCost) * 100;
        } else if (!calculatedMarkupPercentage) {
          calculatedMarkupPercentage = config.pharmacy.defaultMarkupPercentage;
        }

        // Calculate selling price if not provided
        let calculatedSellingPrice = sellingPrice;
        if (!calculatedSellingPrice && unitCost && calculatedMarkupPercentage) {
          calculatedSellingPrice = unitCost * (1 + calculatedMarkupPercentage / 100);
        }

        // Insert new product
        const insertProductQuery = `
          INSERT INTO products (
            product_code, product_name, generic_name, brand_name, category_id,
            dosage_form, strength, unit_of_measure, description, manufacturer,
            requires_prescription, controlled_substance, storage_conditions,
            minimum_stock_level, maximum_stock_level, reorder_point,
            unit_cost, selling_price, markup_percentage, tax_rate
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
          RETURNING product_id, product_code, created_at
        `;
        
        const result = await client.query(insertProductQuery, [
          productCode, productName, genericName, brandName, categoryId,
          dosageForm, strength, unitOfMeasure, description, manufacturer,
          requiresPrescription, controlledSubstance, storageConditions,
          minimumStockLevel, maximumStockLevel, reorderPoint,
          unitCost, calculatedSellingPrice, calculatedMarkupPercentage, taxRate
        ]);

        const newProduct = result.rows[0];

        logger.info('New product created', {
          productId: newProduct.product_id,
          productCode: newProduct.product_code,
          productName: productName,
          createdBy: req.user.userId
        });

        // Get complete product data for response
        const productQuery = `
          SELECT 
            p.*, c.category_name
          FROM products p
          LEFT JOIN categories c ON p.category_id = c.category_id
          WHERE p.product_id = $1
        `;
        
        const productResult = await client.query(productQuery, [newProduct.product_id]);
        const createdProduct = productResult.rows[0];

        res.status(201).json({
          success: true,
          message: 'Product created successfully',
          data: {
            product: {
              id: createdProduct.product_id,
              productCode: createdProduct.product_code,
              productName: createdProduct.product_name,
              genericName: createdProduct.generic_name,
              brandName: createdProduct.brand_name,
              category: {
                id: createdProduct.category_id,
                name: createdProduct.category_name
              },
              dosageForm: createdProduct.dosage_form,
              strength: createdProduct.strength,
              unitOfMeasure: createdProduct.unit_of_measure,
              description: createdProduct.description,
              manufacturer: createdProduct.manufacturer,
              requiresPrescription: createdProduct.requires_prescription,
              controlledSubstance: createdProduct.controlled_substance,
              storageConditions: createdProduct.storage_conditions,
              minimumStockLevel: createdProduct.minimum_stock_level,
              maximumStockLevel: createdProduct.maximum_stock_level,
              reorderPoint: createdProduct.reorder_point,
              unitCost: parseFloat(createdProduct.unit_cost || 0),
              sellingPrice: parseFloat(createdProduct.selling_price || 0),
              markupPercentage: parseFloat(createdProduct.markup_percentage || 0),
              taxRate: parseFloat(createdProduct.tax_rate || 0),
              isActive: createdProduct.is_active,
              createdAt: createdProduct.created_at
            }
          }
        });
      });

    } catch (error) {
      logger.error('Create product error:', error.message);
      res.status(400).json({
        success: false,
        message: error.message || 'Failed to create product'
      });
    }
  }

  /**
   * Update product
   */
  static async updateProduct(req, res) {
    try {
      const { productId } = req.params;
      const updateData = req.body;

      if (!productId || isNaN(productId)) {
        return res.status(400).json({
          success: false,
          message: 'Valid product ID is required'
        });
      }

      // Validate numeric fields if provided
      const numericFields = ['unitCost', 'sellingPrice', 'markupPercentage', 'taxRate', 'minimumStockLevel', 'maximumStockLevel', 'reorderPoint'];
      for (const field of numericFields) {
        if (updateData[field] !== undefined && (isNaN(updateData[field]) || updateData[field] < 0)) {
          return res.status(400).json({
            success: false,
            message: `${field} must be a valid positive number`
          });
        }
      }

      await transaction(async (client) => {
        // Check if product exists
        const productExistsQuery = `SELECT product_id FROM products WHERE product_id = $1`;
        const productExists = await client.query(productExistsQuery, [productId]);

        if (productExists.rows.length === 0) {
          throw new Error('Product not found');
        }

        // Verify category exists if provided
        if (updateData.categoryId) {
          const categoryQuery = `SELECT category_id FROM categories WHERE category_id = $1 AND is_active = TRUE`;
          const categoryResult = await client.query(categoryQuery, [updateData.categoryId]);
          
          if (categoryResult.rows.length === 0) {
            throw new Error('Invalid or inactive category specified');
          }
        }

        // Build update query dynamically
        const updateFields = [];
        const updateValues = [];
        let paramIndex = 1;

        const fieldMappings = {
          productName: 'product_name',
          genericName: 'generic_name',
          brandName: 'brand_name',
          categoryId: 'category_id',
          dosageForm: 'dosage_form',
          strength: 'strength',
          unitOfMeasure: 'unit_of_measure',
          description: 'description',
          manufacturer: 'manufacturer',
          requiresPrescription: 'requires_prescription',
          controlledSubstance: 'controlled_substance',
          storageConditions: 'storage_conditions',
          minimumStockLevel: 'minimum_stock_level',
          maximumStockLevel: 'maximum_stock_level',
          reorderPoint: 'reorder_point',
          unitCost: 'unit_cost',
          sellingPrice: 'selling_price',
          markupPercentage: 'markup_percentage',
          taxRate: 'tax_rate',
          isActive: 'is_active'
        };

        for (const [jsField, dbField] of Object.entries(fieldMappings)) {
          if (updateData[jsField] !== undefined) {
            updateFields.push(`${dbField} = $${paramIndex}`);
            updateValues.push(updateData[jsField]);
            paramIndex++;
          }
        }

        if (updateFields.length === 0) {
          throw new Error('No fields to update');
        }

        updateFields.push('updated_at = NOW()');
        updateValues.push(productId);

        const updateQuery = `
          UPDATE products 
          SET ${updateFields.join(', ')}
          WHERE product_id = $${paramIndex}
          RETURNING product_id
        `;

        await client.query(updateQuery, updateValues);

        // Get updated product data
        const productQuery = `
          SELECT 
            p.*, c.category_name
          FROM products p
          LEFT JOIN categories c ON p.category_id = c.category_id
          WHERE p.product_id = $1
        `;
        
        const result = await client.query(productQuery, [productId]);
        const updatedProduct = result.rows[0];

        logger.info('Product updated', {
          productId: updatedProduct.product_id,
          productCode: updatedProduct.product_code,
          updatedBy: req.user.userId
        });

        res.json({
          success: true,
          message: 'Product updated successfully',
          data: {
            product: {
              id: updatedProduct.product_id,
              productCode: updatedProduct.product_code,
              productName: updatedProduct.product_name,
              genericName: updatedProduct.generic_name,
              brandName: updatedProduct.brand_name,
              category: {
                id: updatedProduct.category_id,
                name: updatedProduct.category_name
              },
              dosageForm: updatedProduct.dosage_form,
              strength: updatedProduct.strength,
              unitOfMeasure: updatedProduct.unit_of_measure,
              description: updatedProduct.description,
              manufacturer: updatedProduct.manufacturer,
              requiresPrescription: updatedProduct.requires_prescription,
              controlledSubstance: updatedProduct.controlled_substance,
              storageConditions: updatedProduct.storage_conditions,
              minimumStockLevel: updatedProduct.minimum_stock_level,
              maximumStockLevel: updatedProduct.maximum_stock_level,
              reorderPoint: updatedProduct.reorder_point,
              unitCost: parseFloat(updatedProduct.unit_cost || 0),
              sellingPrice: parseFloat(updatedProduct.selling_price || 0),
              markupPercentage: parseFloat(updatedProduct.markup_percentage || 0),
              taxRate: parseFloat(updatedProduct.tax_rate || 0),
              isActive: updatedProduct.is_active,
              createdAt: updatedProduct.created_at,
              updatedAt: updatedProduct.updated_at
            }
          }
        });
      });

    } catch (error) {
      logger.error('Update product error:', error.message);
      res.status(400).json({
        success: false,
        message: error.message || 'Failed to update product'
      });
    }
  }

  /**
   * Delete product (soft delete)
   */
  static async deleteProduct(req, res) {
    try {
      const { productId } = req.params;

      if (!productId || isNaN(productId)) {
        return res.status(400).json({
          success: false,
          message: 'Valid product ID is required'
        });
      }

      await transaction(async (client) => {
        // Check if product has active inventory
        const inventoryQuery = `
          SELECT COUNT(*) as count 
          FROM inventory 
          WHERE product_id = $1 AND status = 'active' AND quantity_on_hand > 0
        `;
        const inventoryResult = await client.query(inventoryQuery, [productId]);
        
        if (parseInt(inventoryResult.rows[0].count) > 0) {
          throw new Error('Cannot delete product with active inventory. Please remove all inventory first.');
        }

        // Check if product has been used in sales
        const salesQuery = `
          SELECT COUNT(*) as count 
          FROM sale_items si
          JOIN sales s ON si.sale_id = s.sale_id
          WHERE si.product_id = $1 AND s.sale_date >= NOW() - INTERVAL '90 days'
        `;
        const salesResult = await client.query(salesQuery, [productId]);
        
        if (parseInt(salesResult.rows[0].count) > 0) {
          // If product has recent sales, only allow soft delete
          const softDeleteQuery = `
            UPDATE products 
            SET is_active = FALSE, updated_at = NOW()
            WHERE product_id = $1
            RETURNING product_code, product_name
          `;
          const result = await client.query(softDeleteQuery, [productId]);
          
          if (result.rows.length === 0) {
            throw new Error('Product not found');
          }

          const deletedProduct = result.rows[0];

          logger.info('Product soft deleted (has recent sales)', {
            productId: productId,
            productCode: deletedProduct.product_code,
            productName: deletedProduct.product_name,
            deletedBy: req.user.userId
          });

          return res.json({
            success: true,
            message: 'Product deactivated successfully (has recent sales history)',
            data: {
              productId: parseInt(productId),
              action: 'deactivated'
            }
          });
        }

        // Check if product exists
        const productExistsQuery = `SELECT product_id, product_code, product_name FROM products WHERE product_id = $1`;
        const productExists = await client.query(productExistsQuery, [productId]);

        if (productExists.rows.length === 0) {
          throw new Error('Product not found');
        }

        const product = productExists.rows[0];

        // Perform soft delete (set is_active to false)
        const deleteQuery = `
          UPDATE products 
          SET is_active = FALSE, updated_at = NOW()
          WHERE product_id = $1
        `;
        await client.query(deleteQuery, [productId]);

        logger.info('Product deleted', {
          productId: productId,
          productCode: product.product_code,
          productName: product.product_name,
          deletedBy: req.user.userId
        });

        res.json({
          success: true,
          message: 'Product deleted successfully',
          data: {
            productId: parseInt(productId),
            action: 'deleted'
          }
        });
      });

    } catch (error) {
      logger.error('Delete product error:', error.message);
      res.status(400).json({
        success: false,
        message: error.message || 'Failed to delete product'
      });
    }
  }

  /**
   * Get product inventory details
   */
  static async getProductInventory(req, res) {
    try {
      const { productId } = req.params;

      if (!productId || isNaN(productId)) {
        return res.status(400).json({
          success: false,
          message: 'Valid product ID is required'
        });
      }

      const inventoryQuery = `
        SELECT 
          i.inventory_id,
          i.batch_number,
          i.lot_number,
          i.quantity_on_hand,
          i.quantity_reserved,
          i.quantity_available,
          i.unit_cost,
          i.manufacturing_date,
          i.expiration_date,
          i.received_date,
          i.location,
          i.status,
          i.notes,
          s.supplier_name,
          s.supplier_id,
          CASE 
            WHEN i.expiration_date < CURRENT_DATE THEN 'Expired'
            WHEN (i.expiration_date - CURRENT_DATE) <= 30 THEN 'Critical'
            WHEN (i.expiration_date - CURRENT_DATE) <= 60 THEN 'Warning'
            ELSE 'Normal'
          END as expiry_status,
          (i.expiration_date - CURRENT_DATE) as days_to_expiry
        FROM inventory i
        LEFT JOIN suppliers s ON i.supplier_id = s.supplier_id
        WHERE i.product_id = $1 AND i.quantity_on_hand > 0
        ORDER BY i.expiration_date ASC, i.received_date ASC
      `;

      const result = await query(inventoryQuery, [productId]);

      // Get product basic info
      const productQuery = `
        SELECT product_code, product_name, brand_name 
        FROM products 
        WHERE product_id = $1
      `;
      const productResult = await query(productQuery, [productId]);

      if (productResult.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'Product not found'
        });
      }

      const product = productResult.rows[0];

      // Calculate summary statistics
      const totalQuantity = result.rows.reduce((sum, item) => sum + parseInt(item.quantity_on_hand), 0);
      const totalReserved = result.rows.reduce((sum, item) => sum + parseInt(item.quantity_reserved), 0);
      const totalAvailable = result.rows.reduce((sum, item) => sum + parseInt(item.quantity_available), 0);
      const totalValue = result.rows.reduce((sum, item) => sum + (parseFloat(item.unit_cost || 0) * parseInt(item.quantity_on_hand)), 0);

      res.json({
        success: true,
        data: {
          product: {
            id: parseInt(productId),
            productCode: product.product_code,
            productName: product.product_name,
            brandName: product.brand_name
          },
          summary: {
            totalQuantity,
            totalReserved,
            totalAvailable,
            totalValue: parseFloat(totalValue.toFixed(2)),
            batchCount: result.rows.length
          },
          inventory: result.rows.map(item => ({
            inventoryId: item.inventory_id,
            batchNumber: item.batch_number,
            lotNumber: item.lot_number,
            quantityOnHand: parseInt(item.quantity_on_hand),
            quantityReserved: parseInt(item.quantity_reserved),
            quantityAvailable: parseInt(item.quantity_available),
            unitCost: parseFloat(item.unit_cost || 0),
            manufacturingDate: item.manufacturing_date,
            expirationDate: item.expiration_date,
            receivedDate: item.received_date,
            location: item.location,
            status: item.status,
            notes: item.notes,
            supplier: {
              id: item.supplier_id,
              name: item.supplier_name
            },
            expiryStatus: item.expiry_status,
            daysToExpiry: item.days_to_expiry
          }))
        }
      });

    } catch (error) {
      logger.error('Get product inventory error:', error.message);
      res.status(500).json({
        success: false,
        message: 'Failed to retrieve product inventory'
      });
    }
  }

  /**
   * Get low stock products
   */
  static async getLowStockProducts(req, res) {
    try {
      const { limit = 50 } = req.query;
      const limitNum = Math.min(100, Math.max(1, parseInt(limit)));

      const lowStockQuery = `
        SELECT * FROM low_stock_products
        ORDER BY shortage_quantity DESC
        LIMIT $1
      `;

      const result = await query(lowStockQuery, [limitNum]);

      res.json({
        success: true,
        data: {
          products: result.rows.map(product => ({
            id: product.product_id,
            productCode: product.product_code,
            productName: product.product_name,
            brandName: product.brand_name,
            availableQuantity: parseInt(product.available_quantity),
            minimumStockLevel: product.minimum_stock_level,
            reorderPoint: product.reorder_point,
            shortageQuantity: product.shortage_quantity
          }))
        }
      });

    } catch (error) {
      logger.error('Get low stock products error:', error.message);
      res.status(500).json({
        success: false,
        message: 'Failed to retrieve low stock products'
      });
    }
  }

  /**
   * Get products by category
   */
  static async getProductsByCategory(req, res) {
    try {
      const { categoryId } = req.params;
      const { page = 1, limit = 20, isActive = true } = req.query;

      if (!categoryId || isNaN(categoryId)) {
        return res.status(400).json({
          success: false,
          message: 'Valid category ID is required'
        });
      }

      const pageNum = Math.max(1, parseInt(page));
      const limitNum = Math.min(100, Math.max(1, parseInt(limit)));
      const offset = (pageNum - 1) * limitNum;

      // Check if category exists
      const categoryQuery = `
        SELECT category_name FROM categories 
        WHERE category_id = $1 AND is_active = TRUE
      `;
      const categoryResult = await query(categoryQuery, [categoryId]);

      if (categoryResult.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'Category not found'
        });
      }

      const categoryName = categoryResult.rows[0].category_name;

      // Get products count
      const countQuery = `
        SELECT COUNT(*) as total 
        FROM products 
        WHERE category_id = $1 AND is_active = $2
      `;
      const countResult = await query(countQuery, [categoryId, isActive === 'true']);
      const totalProducts = parseInt(countResult.rows[0].total);

      // Get products
      const productsQuery = `
        SELECT 
          p.product_id, p.product_code, p.product_name, p.generic_name, p.brand_name,
          p.dosage_form, p.strength, p.unit_of_measure, p.manufacturer,
          p.requires_prescription, p.controlled_substance, p.unit_cost, p.selling_price,
          p.minimum_stock_level, p.reorder_point, p.is_active,
          COALESCE(SUM(i.quantity_available), 0) as available_quantity
        FROM products p
        LEFT JOIN inventory i ON p.product_id = i.product_id AND i.status = 'active'
        WHERE p.category_id = $1 AND p.is_active = $2
        GROUP BY p.product_id
        ORDER BY p.product_name
        LIMIT $3 OFFSET $4
      `;

      const productsResult = await query(productsQuery, [categoryId, isActive === 'true', limitNum, offset]);

      const pagination = generatePagination(pageNum, limitNum, totalProducts);

      res.json({
        success: true,
        data: {
          category: {
            id: parseInt(categoryId),
            name: categoryName
          },
          products: productsResult.rows.map(product => ({
            id: product.product_id,
            productCode: product.product_code,
            productName: product.product_name,
            genericName: product.generic_name,
            brandName: product.brand_name,
            dosageForm: product.dosage_form,
            strength: product.strength,
            unitOfMeasure: product.unit_of_measure,
            manufacturer: product.manufacturer,
            requiresPrescription: product.requires_prescription,
            controlledSubstance: product.controlled_substance,
            unitCost: parseFloat(product.unit_cost || 0),
            sellingPrice: parseFloat(product.selling_price || 0),
            minimumStockLevel: product.minimum_stock_level,
            reorderPoint: product.reorder_point,
            availableQuantity: parseInt(product.available_quantity),
            isActive: product.is_active
          })),
          pagination
        }
      });

    } catch (error) {
      logger.error('Get products by category error:', error.message);
      res.status(500).json({
        success: false,
        message: 'Failed to retrieve products by category'
      });
    }
  }

  /**
   * Search products with advanced filters
   */
  static async searchProducts(req, res) {
    try {
      const {
        q: searchTerm,
        category,
        manufacturer,
        requiresPrescription,
        controlledSubstance,
        minPrice,
        maxPrice,
        inStock = true,
        page = 1,
        limit = 20,
        sortBy = 'relevance',
        sortOrder = 'DESC'
      } = req.query;

      if (!searchTerm || searchTerm.trim().length < 2) {
        return res.status(400).json({
          success: false,
          message: 'Search term must be at least 2 characters long'
        });
      }

      const pageNum = Math.max(1, parseInt(page));
      const limitNum = Math.min(100, Math.max(1, parseInt(limit)));
      const offset = (pageNum - 1) * limitNum;

      // Build WHERE clause
      let whereClause = `WHERE p.is_active = TRUE`;
      const queryParams = [`%${searchTerm.trim()}%`];
      let paramIndex = 2;

      // Add search condition
      whereClause += ` AND (
        p.product_name ILIKE $1 OR 
        p.generic_name ILIKE $1 OR 
        p.brand_name ILIKE $1 OR 
        p.product_code ILIKE $1 OR
        p.manufacturer ILIKE $1 OR
        p.description ILIKE $1
      )`;

      if (category) {
        whereClause += ` AND p.category_id = ${paramIndex}`;
        queryParams.push(category);
        paramIndex++;
      }

      if (manufacturer) {
        whereClause += ` AND p.manufacturer ILIKE ${paramIndex}`;
        queryParams.push(`%${manufacturer}%`);
        paramIndex++;
      }

      if (requiresPrescription !== undefined) {
        whereClause += ` AND p.requires_prescription = ${paramIndex}`;
        queryParams.push(requiresPrescription === 'true');
        paramIndex++;
      }

      if (controlledSubstance !== undefined) {
        whereClause += ` AND p.controlled_substance = ${paramIndex}`;
        queryParams.push(controlledSubstance === 'true');
        paramIndex++;
      }

      if (minPrice !== undefined) {
        whereClause += ` AND p.selling_price >= ${paramIndex}`;
        queryParams.push(parseFloat(minPrice));
        paramIndex++;
      }

      if (maxPrice !== undefined) {
        whereClause += ` AND p.selling_price <= ${paramIndex}`;
        queryParams.push(parseFloat(maxPrice));
        paramIndex++;
      }

      // Add stock filter
      if (inStock === 'true') {
        whereClause += ` AND COALESCE(SUM(i.quantity_available), 0) > 0`;
      }

      // Determine sort clause
      let sortClause = 'ORDER BY ';
      if (sortBy === 'relevance') {
        sortClause += `
          CASE 
            WHEN p.product_name ILIKE $1 THEN 1
            WHEN p.brand_name ILIKE $1 THEN 2
            WHEN p.generic_name ILIKE $1 THEN 3
            WHEN p.product_code ILIKE $1 THEN 4
            ELSE 5
          END, p.product_name
        `;
      } else {
        const allowedSortFields = {
          'name': 'p.product_name',
          'price': 'p.selling_price',
          'created': 'p.created_at',
          'stock': 'available_quantity'
        };
        const sortField = allowedSortFields[sortBy] || 'p.product_name';
        const sortDir = sortOrder.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
        sortClause += `${sortField} ${sortDir}`;
      }

      // Get total count
      const countQuery = `
        SELECT COUNT(DISTINCT p.product_id) as total
        FROM products p
        LEFT JOIN inventory i ON p.product_id = i.product_id AND i.status = 'active'
        LEFT JOIN categories c ON p.category_id = c.category_id
        ${whereClause}
      `;
      const countResult = await query(countQuery, queryParams);
      const totalProducts = parseInt(countResult.rows[0].total);

      // Get search results
      const searchQuery = `
        SELECT 
          p.product_id, p.product_code, p.product_name, p.generic_name, p.brand_name,
          p.category_id, c.category_name, p.dosage_form, p.strength, p.unit_of_measure,
          p.manufacturer, p.requires_prescription, p.controlled_substance,
          p.unit_cost, p.selling_price, p.minimum_stock_level, p.reorder_point,
          COALESCE(SUM(i.quantity_available), 0) as available_quantity,
          MIN(CASE WHEN i.status = 'active' AND i.quantity_on_hand > 0 THEN i.expiration_date END) as nearest_expiration
        FROM products p
        LEFT JOIN inventory i ON p.product_id = i.product_id AND i.status = 'active'
        LEFT JOIN categories c ON p.category_id = c.category_id
        ${whereClause}
        GROUP BY p.product_id, c.category_name
        ${sortClause}
        LIMIT ${paramIndex} OFFSET ${paramIndex + 1}
      `;
      queryParams.push(limitNum, offset);

      const searchResult = await query(searchQuery, queryParams);

      const pagination = generatePagination(pageNum, limitNum, totalProducts);

      res.json({
        success: true,
        data: {
          searchTerm: searchTerm.trim(),
          totalResults: totalProducts,
          products: searchResult.rows.map(product => ({
            id: product.product_id,
            productCode: product.product_code,
            productName: product.product_name,
            genericName: product.generic_name,
            brandName: product.brand_name,
            category: {
              id: product.category_id,
              name: product.category_name
            },
            dosageForm: product.dosage_form,
            strength: product.strength,
            unitOfMeasure: product.unit_of_measure,
            manufacturer: product.manufacturer,
            requiresPrescription: product.requires_prescription,
            controlledSubstance: product.controlled_substance,
            unitCost: parseFloat(product.unit_cost || 0),
            sellingPrice: parseFloat(product.selling_price || 0),
            minimumStockLevel: product.minimum_stock_level,
            reorderPoint: product.reorder_point,
            availableQuantity: parseInt(product.available_quantity),
            nearestExpiration: product.nearest_expiration,
            stockStatus: parseInt(product.available_quantity) > 0 ? 'In Stock' : 'Out of Stock'
          })),
          pagination,
          filters: {
            category,
            manufacturer,
            requiresPrescription,
            controlledSubstance,
            minPrice,
            maxPrice,
            inStock
          }
        }
      });

    } catch (error) {
      logger.error('Search products error:', error.message);
      res.status(500).json({
        success: false,
        message: 'Failed to search products'
      });
    }
  }

  /**
   * Get product price history
   */
  static async getProductPriceHistory(req, res) {
    try {
      const { productId } = req.params;
      const { limit = 10 } = req.query;

      if (!productId || isNaN(productId)) {
        return res.status(400).json({
          success: false,
          message: 'Valid product ID is required'
        });
      }

      const limitNum = Math.min(50, Math.max(1, parseInt(limit)));

      // Get price history from audit log
      const priceHistoryQuery = `
        SELECT 
          al.created_at,
          al.old_values->>'unit_cost' as old_unit_cost,
          al.new_values->>'unit_cost' as new_unit_cost,
          al.old_values->>'selling_price' as old_selling_price,
          al.new_values->>'selling_price' as new_selling_price,
          u.first_name || ' ' || u.last_name as changed_by_name
        FROM audit_log al
        LEFT JOIN users u ON al.changed_by = u.user_id
        WHERE al.table_name = 'products' 
          AND al.record_id = $1 
          AND al.action = 'UPDATE'
          AND (
            al.old_values ? 'unit_cost' OR 
            al.old_values ? 'selling_price'
          )
        ORDER BY al.created_at DESC
        LIMIT $2
      `;

      const historyResult = await query(priceHistoryQuery, [productId, limitNum]);

      // Get current product info
      const productQuery = `
        SELECT product_code, product_name, unit_cost, selling_price
        FROM products 
        WHERE product_id = $1
      `;
      const productResult = await query(productQuery, [productId]);

      if (productResult.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'Product not found'
        });
      }

      const product = productResult.rows[0];

      res.json({
        success: true,
        data: {
          product: {
            id: parseInt(productId),
            productCode: product.product_code,
            productName: product.product_name,
            currentUnitCost: parseFloat(product.unit_cost || 0),
            currentSellingPrice: parseFloat(product.selling_price || 0)
          },
          priceHistory: historyResult.rows.map(record => ({
            date: record.created_at,
            changes: {
              unitCost: {
                old: record.old_unit_cost ? parseFloat(record.old_unit_cost) : null,
                new: record.new_unit_cost ? parseFloat(record.new_unit_cost) : null
              },
              sellingPrice: {
                old: record.old_selling_price ? parseFloat(record.old_selling_price) : null,
                new: record.new_selling_price ? parseFloat(record.new_selling_price) : null
              }
            },
            changedBy: record.changed_by_name
          }))
        }
      });

    } catch (error) {
      logger.error('Get product price history error:', error.message);
      res.status(500).json({
        success: false,
        message: 'Failed to retrieve product price history'
      });
    }
  }

  /**
   * Bulk update products
   */
  static async bulkUpdateProducts(req, res) {
    try {
      const { products, updateFields } = req.body;

      if (!Array.isArray(products) || products.length === 0) {
        return res.status(400).json({
          success: false,
          message: 'Products array is required and cannot be empty'
        });
      }

      if (!updateFields || Object.keys(updateFields).length === 0) {
        return res.status(400).json({
          success: false,
          message: 'Update fields are required'
        });
      }

      if (products.length > 100) {
        return res.status(400).json({
          success: false,
          message: 'Cannot update more than 100 products at once'
        });
      }

      const results = {
        updated: [],
        failed: [],
        total: products.length
      };

      await transaction(async (client) => {
        for (const productId of products) {
          try {
            // Validate product ID
            if (!productId || isNaN(productId)) {
              results.failed.push({
                productId,
                error: 'Invalid product ID'
              });
              continue;
            }

            // Check if product exists
            const productExistsQuery = `SELECT product_id, product_code FROM products WHERE product_id = $1`;
            const productExists = await client.query(productExistsQuery, [productId]);

            if (productExists.rows.length === 0) {
              results.failed.push({
                productId,
                error: 'Product not found'
              });
              continue;
            }

            // Build update query
            const updateFieldsArray = [];
            const updateValues = [];
            let paramIndex = 1;

            const fieldMappings = {
              categoryId: 'category_id',
              unitCost: 'unit_cost',
              sellingPrice: 'selling_price',
              markupPercentage: 'markup_percentage',
              taxRate: 'tax_rate',
              minimumStockLevel: 'minimum_stock_level',
              maximumStockLevel: 'maximum_stock_level',
              reorderPoint: 'reorder_point',
              isActive: 'is_active'
            };

            for (const [jsField, dbField] of Object.entries(fieldMappings)) {
              if (updateFields[jsField] !== undefined) {
                updateFieldsArray.push(`${dbField} = ${paramIndex}`);
                updateValues.push(updateFields[jsField]);
                paramIndex++;
              }
            }

            if (updateFieldsArray.length === 0) {
              results.failed.push({
                productId,
                error: 'No valid fields to update'
              });
              continue;
            }

            updateFieldsArray.push('updated_at = NOW()');
            updateValues.push(productId);

            const updateQuery = `
              UPDATE products 
              SET ${updateFieldsArray.join(', ')}
              WHERE product_id = ${paramIndex}
            `;

            await client.query(updateQuery, updateValues);

            results.updated.push({
              productId: parseInt(productId),
              productCode: productExists.rows[0].product_code
            });

          } catch (error) {
            results.failed.push({
              productId,
              error: error.message
            });
          }
        }

        logger.info('Bulk product update completed', {
          totalProducts: results.total,
          updated: results.updated.length,
          failed: results.failed.length,
          updatedBy: req.user.userId
        });
      });

      res.json({
        success: true,
        message: `Bulk update completed. ${results.updated.length} products updated, ${results.failed.length} failed.`,
        data: results
      });

    } catch (error) {
      logger.error('Bulk update products error:', error.message);
      res.status(500).json({
        success: false,
        message: 'Failed to perform bulk update'
      });
    }
  }
}

module.exports = ProductController;
