const { query, transaction } = require('../config/database');
const logger = require('../utils/logger');
const { generatePagination } = require('../utils/helpers');

class CategoryController {
  /**
   * Get all categories with pagination and filtering
   */
  static async getAllCategories(req, res) {
    try {
      const { 
        page = 1, 
        limit = 20, 
        isActive,
        includeHierarchy = 'true',
        sortBy = 'category_name',
        sortOrder = 'ASC'
      } = req.query;

      // Validate pagination parameters
      const pageNum = Math.max(1, parseInt(page));
      const limitNum = Math.min(100, Math.max(1, parseInt(limit)));
      const offset = (pageNum - 1) * limitNum;

      // Validate sort parameters
      const allowedSortFields = ['category_name', 'created_at', 'updated_at'];
      const sortField = allowedSortFields.includes(sortBy) ? sortBy : 'category_name';
      const sortDir = sortOrder.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

      // Build WHERE clause
      let whereClause = 'WHERE 1=1';
      const queryParams = [];
      let paramIndex = 1;

      if (isActive !== undefined) {
        whereClause += ` AND c.is_active = $${paramIndex}`;
        queryParams.push(isActive === 'true');
        paramIndex++;
      }

      // Get total count
      const countQuery = `
        SELECT COUNT(*) as total 
        FROM categories c
        ${whereClause}
      `;
      const countResult = await query(countQuery, queryParams);
      const totalCategories = parseInt(countResult.rows[0].total);

      // Get categories with hierarchy information
      const categoriesQuery = `
        SELECT 
          c.category_id,
          c.category_name,
          c.description,
          c.parent_category_id,
          pc.category_name as parent_category_name,
          c.is_active,
          c.created_at,
          -- Count of direct subcategories
          (SELECT COUNT(*) FROM categories WHERE parent_category_id = c.category_id AND is_active = TRUE) as subcategory_count,
          -- Count of products in this category
          (SELECT COUNT(*) FROM products WHERE category_id = c.category_id AND is_active = TRUE) as product_count
        FROM categories c
        LEFT JOIN categories pc ON c.parent_category_id = pc.category_id
        ${whereClause}
        ORDER BY c.${sortField} ${sortDir}
        LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
      `;
      queryParams.push(limitNum, offset);

      const categoriesResult = await query(categoriesQuery, queryParams);

      // Build hierarchy if requested
      let categories = categoriesResult.rows.map(category => ({
        id: category.category_id,
        name: category.category_name,
        description: category.description,
        parentCategoryId: category.parent_category_id,
        parentCategoryName: category.parent_category_name,
        subcategoryCount: parseInt(category.subcategory_count),
        productCount: parseInt(category.product_count),
        isActive: category.is_active,
        createdAt: category.created_at
      }));

      // If hierarchy is requested, organize categories in tree structure
      if (includeHierarchy === 'true') {
        categories = buildCategoryHierarchy(categories);
      }

      const pagination = generatePagination(pageNum, limitNum, totalCategories);

      res.json({
        success: true,
        data: {
          categories,
          pagination
        }
      });

    } catch (error) {
      logger.error('Get all categories error:', error.message);
      res.status(500).json({
        success: false,
        message: 'Failed to retrieve categories'
      });
    }
  }

  /**
   * Get category by ID
   */
  static async getCategoryById(req, res) {
    try {
      const { categoryId } = req.params;
      const { includeProducts = 'false' } = req.query;

      if (!categoryId || isNaN(categoryId)) {
        return res.status(400).json({
          success: false,
          message: 'Valid category ID is required'
        });
      }

      const categoryQuery = `
        SELECT 
          c.category_id,
          c.category_name,
          c.description,
          c.parent_category_id,
          pc.category_name as parent_category_name,
          c.is_active,
          c.created_at,
          -- Count of direct subcategories
          (SELECT COUNT(*) FROM categories WHERE parent_category_id = c.category_id AND is_active = TRUE) as subcategory_count,
          -- Count of products in this category
          (SELECT COUNT(*) FROM products WHERE category_id = c.category_id AND is_active = TRUE) as product_count
        FROM categories c
        LEFT JOIN categories pc ON c.parent_category_id = pc.category_id
        WHERE c.category_id = $1
      `;

      const result = await query(categoryQuery, [categoryId]);

      if (result.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'Category not found'
        });
      }

      const category = result.rows[0];

      const categoryData = {
        id: category.category_id,
        name: category.category_name,
        description: category.description,
        parentCategoryId: category.parent_category_id,
        parentCategoryName: category.parent_category_name,
        subcategoryCount: parseInt(category.subcategory_count),
        productCount: parseInt(category.product_count),
        isActive: category.is_active,
        createdAt: category.created_at
      };

      // Get subcategories
      const subcategoriesQuery = `
        SELECT 
          category_id, category_name, description, is_active,
          (SELECT COUNT(*) FROM products WHERE category_id = c.category_id AND is_active = TRUE) as product_count
        FROM categories c
        WHERE parent_category_id = $1 AND is_active = TRUE
        ORDER BY category_name
      `;
      const subcategoriesResult = await query(subcategoriesQuery, [categoryId]);

      categoryData.subcategories = subcategoriesResult.rows.map(subcat => ({
        id: subcat.category_id,
        name: subcat.category_name,
        description: subcat.description,
        productCount: parseInt(subcat.product_count),
        isActive: subcat.is_active
      }));

      // Include products if requested
      if (includeProducts === 'true') {
        const productsQuery = `
          SELECT 
            p.product_id, p.product_code, p.product_name, p.brand_name,
            p.unit_cost, p.selling_price, p.is_active,
            COALESCE(SUM(i.quantity_available), 0) as available_quantity
          FROM products p
          LEFT JOIN inventory i ON p.product_id = i.product_id AND i.status = 'active'
          WHERE p.category_id = $1 AND p.is_active = TRUE
          GROUP BY p.product_id
          ORDER BY p.product_name
          LIMIT 50
        `;
        const productsResult = await query(productsQuery, [categoryId]);

        categoryData.products = productsResult.rows.map(product => ({
          id: product.product_id,
          productCode: product.product_code,
          productName: product.product_name,
          brandName: product.brand_name,
          unitCost: parseFloat(product.unit_cost || 0),
          sellingPrice: parseFloat(product.selling_price || 0),
          availableQuantity: parseInt(product.available_quantity),
          isActive: product.is_active
        }));
      }

      res.json({
        success: true,
        data: {
          category: categoryData
        }
      });

    } catch (error) {
      logger.error('Get category by ID error:', error.message);
      res.status(500).json({
        success: false,
        message: 'Failed to retrieve category'
      });
    }
  }

  /**
   * Create new category
   */
  static async createCategory(req, res) {
    try {
      const {
        categoryName,
        description,
        parentCategoryId
      } = req.body;

      // Input validation
      if (!categoryName || categoryName.trim().length === 0) {
        return res.status(400).json({
          success: false,
          message: 'Category name is required'
        });
      }

      if (categoryName.trim().length > 255) {
        return res.status(400).json({
          success: false,
          message: 'Category name must be 255 characters or less'
        });
      }

      await transaction(async (client) => {
        // Check if category name already exists at the same level
        let nameCheckQuery;
        let nameCheckParams;

        if (parentCategoryId) {
          nameCheckQuery = `
            SELECT category_id FROM categories 
            WHERE LOWER(category_name) = LOWER($1) AND parent_category_id = $2 AND is_active = TRUE
          `;
          nameCheckParams = [categoryName.trim(), parentCategoryId];
        } else {
          nameCheckQuery = `
            SELECT category_id FROM categories 
            WHERE LOWER(category_name) = LOWER($1) AND parent_category_id IS NULL AND is_active = TRUE
          `;
          nameCheckParams = [categoryName.trim()];
        }

        const nameCheckResult = await client.query(nameCheckQuery, nameCheckParams);
        if (nameCheckResult.rows.length > 0) {
          throw new Error('Category name already exists at this level');
        }

        // Verify parent category exists if provided
        if (parentCategoryId) {
          const parentQuery = `
            SELECT category_id, category_name FROM categories 
            WHERE category_id = $1 AND is_active = TRUE
          `;
          const parentResult = await client.query(parentQuery, [parentCategoryId]);
          
          if (parentResult.rows.length === 0) {
            throw new Error('Parent category not found or inactive');
          }

          // Prevent creating deeply nested categories (max 5 levels)
          const depthQuery = `
            WITH RECURSIVE category_depth AS (
              SELECT category_id, parent_category_id, 1 as level
              FROM categories WHERE category_id = $1
              UNION ALL
              SELECT c.category_id, c.parent_category_id, cd.level + 1
              FROM categories c
              JOIN category_depth cd ON c.parent_category_id = cd.category_id
              WHERE cd.level < 10
            )
            SELECT MAX(level) as max_level FROM category_depth
          `;
          const depthResult = await client.query(depthQuery, [parentCategoryId]);
          const currentDepth = parseInt(depthResult.rows[0].max_level || 0);

          if (currentDepth >= 5) {
            throw new Error('Maximum category depth (5 levels) exceeded');
          }
        }

        // Insert new category
        const insertCategoryQuery = `
          INSERT INTO categories (category_name, description, parent_category_id)
          VALUES ($1, $2, $3)
          RETURNING category_id, category_name, created_at
        `;
        
        const result = await client.query(insertCategoryQuery, [
          categoryName.trim(), 
          description ? description.trim() : null, 
          parentCategoryId || null
        ]);

        const newCategory = result.rows[0];

        logger.info('New category created', {
          categoryId: newCategory.category_id,
          categoryName: newCategory.category_name,
          parentCategoryId: parentCategoryId || null,
          createdBy: req.user.userId
        });

        // Get complete category data for response
        const categoryQuery = `
          SELECT 
            c.category_id, c.category_name, c.description, c.parent_category_id,
            pc.category_name as parent_category_name, c.is_active, c.created_at
          FROM categories c
          LEFT JOIN categories pc ON c.parent_category_id = pc.category_id
          WHERE c.category_id = $1
        `;
        
        const categoryResult = await client.query(categoryQuery, [newCategory.category_id]);
        const createdCategory = categoryResult.rows[0];

        res.status(201).json({
          success: true,
          message: 'Category created successfully',
          data: {
            category: {
              id: createdCategory.category_id,
              name: createdCategory.category_name,
              description: createdCategory.description,
              parentCategoryId: createdCategory.parent_category_id,
              parentCategoryName: createdCategory.parent_category_name,
              isActive: createdCategory.is_active,
              createdAt: createdCategory.created_at
            }
          }
        });
      });

    } catch (error) {
      logger.error('Create category error:', error.message);
      res.status(400).json({
        success: false,
        message: error.message || 'Failed to create category'
      });
    }
  }

  /**
   * Update category
   */
  static async updateCategory(req, res) {
    try {
      const { categoryId } = req.params;
      const { categoryName, description, parentCategoryId, isActive } = req.body;

      if (!categoryId || isNaN(categoryId)) {
        return res.status(400).json({
          success: false,
          message: 'Valid category ID is required'
        });
      }

      if (categoryName && categoryName.trim().length > 255) {
        return res.status(400).json({
          success: false,
          message: 'Category name must be 255 characters or less'
        });
      }

      await transaction(async (client) => {
        // Check if category exists
        const categoryExistsQuery = `SELECT category_id, category_name FROM categories WHERE category_id = $1`;
        const categoryExists = await client.query(categoryExistsQuery, [categoryId]);

        if (categoryExists.rows.length === 0) {
          throw new Error('Category not found');
        }

        // Check for circular reference if updating parent
        if (parentCategoryId && parentCategoryId != categoryId) {
          const circularCheckQuery = `
            WITH RECURSIVE category_path AS (
              SELECT category_id, parent_category_id
              FROM categories WHERE category_id = $1
              UNION ALL
              SELECT c.category_id, c.parent_category_id
              FROM categories c
              JOIN category_path cp ON c.category_id = cp.parent_category_id
              WHERE c.category_id != $2
            )
            SELECT 1 FROM category_path WHERE category_id = $2
          `;
          const circularResult = await client.query(circularCheckQuery, [parentCategoryId, categoryId]);
          
          if (circularResult.rows.length > 0) {
            throw new Error('Cannot set parent category - would create circular reference');
          }
        }

        // Check name uniqueness if updating name
        if (categoryName && categoryName.trim() !== categoryExists.rows[0].category_name) {
          let nameCheckQuery;
          let nameCheckParams;

          if (parentCategoryId) {
            nameCheckQuery = `
              SELECT category_id FROM categories 
              WHERE LOWER(category_name) = LOWER($1) AND parent_category_id = $2 
              AND category_id != $3 AND is_active = TRUE
            `;
            nameCheckParams = [categoryName.trim(), parentCategoryId, categoryId];
          } else {
            nameCheckQuery = `
              SELECT category_id FROM categories 
              WHERE LOWER(category_name) = LOWER($1) AND parent_category_id IS NULL 
              AND category_id != $2 AND is_active = TRUE
            `;
            nameCheckParams = [categoryName.trim(), categoryId];
          }

          const nameCheckResult = await client.query(nameCheckQuery, nameCheckParams);
          if (nameCheckResult.rows.length > 0) {
            throw new Error('Category name already exists at this level');
          }
        }

        // Build update query dynamically
        const updateFields = [];
        const updateValues = [];
        let paramIndex = 1;

        if (categoryName !== undefined) {
          updateFields.push(`category_name = $${paramIndex}`);
          updateValues.push(categoryName.trim());
          paramIndex++;
        }

        if (description !== undefined) {
          updateFields.push(`description = $${paramIndex}`);
          updateValues.push(description ? description.trim() : null);
          paramIndex++;
        }

        if (parentCategoryId !== undefined) {
          updateFields.push(`parent_category_id = $${paramIndex}`);
          updateValues.push(parentCategoryId || null);
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

        updateValues.push(categoryId);

        const updateQuery = `
          UPDATE categories 
          SET ${updateFields.join(', ')}
          WHERE category_id = $${paramIndex}
          RETURNING category_id
        `;

        await client.query(updateQuery, updateValues);

        // If deactivating category, check if it has active products or subcategories
        if (isActive === false) {
          const activeProductsQuery = `
            SELECT COUNT(*) as count FROM products 
            WHERE category_id = $1 AND is_active = TRUE
          `;
          const activeProductsResult = await client.query(activeProductsQuery, [categoryId]);
          
          const activeSubcategoriesQuery = `
            SELECT COUNT(*) as count FROM categories 
            WHERE parent_category_id = $1 AND is_active = TRUE
          `;
          const activeSubcategoriesResult = await client.query(activeSubcategoriesQuery, [categoryId]);

          if (parseInt(activeProductsResult.rows[0].count) > 0) {
            logger.warn('Category deactivated but has active products', {
              categoryId: categoryId,
              activeProducts: activeProductsResult.rows[0].count
            });
          }

          if (parseInt(activeSubcategoriesResult.rows[0].count) > 0) {
            logger.warn('Category deactivated but has active subcategories', {
              categoryId: categoryId,
              activeSubcategories: activeSubcategoriesResult.rows[0].count
            });
          }
        }

        // Get updated category data
        const categoryQuery = `
          SELECT 
            c.category_id, c.category_name, c.description, c.parent_category_id,
            pc.category_name as parent_category_name, c.is_active, c.created_at,
            (SELECT COUNT(*) FROM categories WHERE parent_category_id = c.category_id AND is_active = TRUE) as subcategory_count,
            (SELECT COUNT(*) FROM products WHERE category_id = c.category_id AND is_active = TRUE) as product_count
          FROM categories c
          LEFT JOIN categories pc ON c.parent_category_id = pc.category_id
          WHERE c.category_id = $1
        `;
        
        const result = await client.query(categoryQuery, [categoryId]);
        const updatedCategory = result.rows[0];

        logger.info('Category updated', {
          categoryId: updatedCategory.category_id,
          categoryName: updatedCategory.category_name,
          updatedBy: req.user.userId
        });

        res.json({
          success: true,
          message: 'Category updated successfully',
          data: {
            category: {
              id: updatedCategory.category_id,
              name: updatedCategory.category_name,
              description: updatedCategory.description,
              parentCategoryId: updatedCategory.parent_category_id,
              parentCategoryName: updatedCategory.parent_category_name,
              subcategoryCount: parseInt(updatedCategory.subcategory_count),
              productCount: parseInt(updatedCategory.product_count),
              isActive: updatedCategory.is_active,
              createdAt: updatedCategory.created_at
            }
          }
        });
      });

    } catch (error) {
      logger.error('Update category error:', error.message);
      res.status(400).json({
        success: false,
        message: error.message || 'Failed to update category'
      });
    }
  }

  /**
   * Delete category (soft delete)
   */
  static async deleteCategory(req, res) {
    try {
      const { categoryId } = req.params;
      const { force = 'false' } = req.query;

      if (!categoryId || isNaN(categoryId)) {
        return res.status(400).json({
          success: false,
          message: 'Valid category ID is required'
        });
      }

      await transaction(async (client) => {
        // Check if category exists
        const categoryExistsQuery = `
          SELECT category_id, category_name FROM categories 
          WHERE category_id = $1
        `;
        const categoryExists = await client.query(categoryExistsQuery, [categoryId]);

        if (categoryExists.rows.length === 0) {
          throw new Error('Category not found');
        }

        const category = categoryExists.rows[0];

        // Check if category has active products
        const activeProductsQuery = `
          SELECT COUNT(*) as count FROM products 
          WHERE category_id = $1 AND is_active = TRUE
        `;
        const activeProductsResult = await client.query(activeProductsQuery, [categoryId]);
        const activeProductsCount = parseInt(activeProductsResult.rows[0].count);

        // Check if category has active subcategories
        const activeSubcategoriesQuery = `
          SELECT COUNT(*) as count FROM categories 
          WHERE parent_category_id = $1 AND is_active = TRUE
        `;
        const activeSubcategoriesResult = await client.query(activeSubcategoriesQuery, [categoryId]);
        const activeSubcategoriesCount = parseInt(activeSubcategoriesResult.rows[0].count);

        // Prevent deletion if has active products or subcategories (unless forced)
        if (force !== 'true') {
          if (activeProductsCount > 0) {
            throw new Error(
              `Cannot delete category with ${activeProductsCount} active products. ` +
              'Move products to another category first or use force=true parameter.'
            );
          }

          if (activeSubcategoriesCount > 0) {
            throw new Error(
              `Cannot delete category with ${activeSubcategoriesCount} active subcategories. ` +
              'Delete or move subcategories first or use force=true parameter.'
            );
          }
        }

        // Perform soft delete
        const deleteQuery = `
          UPDATE categories 
          SET is_active = FALSE
          WHERE category_id = $1
        `;
        await client.query(deleteQuery, [categoryId]);

        // If forced deletion and has products, move them to null category
        if (force === 'true' && activeProductsCount > 0) {
          const moveProductsQuery = `
            UPDATE products 
            SET category_id = NULL 
            WHERE category_id = $1
          `;
          await client.query(moveProductsQuery, [categoryId]);

          logger.info('Products moved to uncategorized due to force delete', {
            categoryId: categoryId,
            productCount: activeProductsCount
          });
        }

        // If has subcategories, move them to parent or root level
        if (activeSubcategoriesCount > 0) {
          const getParentQuery = `SELECT parent_category_id FROM categories WHERE category_id = $1`;
          const parentResult = await client.query(getParentQuery, [categoryId]);
          const parentId = parentResult.rows[0].parent_category_id;

          const moveSubcategoriesQuery = `
            UPDATE categories 
            SET parent_category_id = $1 
            WHERE parent_category_id = $2 AND is_active = TRUE
          `;
          await client.query(moveSubcategoriesQuery, [parentId, categoryId]);

          logger.info('Subcategories moved due to category deletion', {
            categoryId: categoryId,
            subcategoryCount: activeSubcategoriesCount,
            movedToParent: parentId || 'root'
          });
        }

        logger.info('Category deleted', {
          categoryId: categoryId,
          categoryName: category.category_name,
          hadProducts: activeProductsCount > 0,
          hadSubcategories: activeSubcategoriesCount > 0,
          forced: force === 'true',
          deletedBy: req.user.userId
        });

        res.json({
          success: true,
          message: `Category deleted successfully${force === 'true' ? ' (forced)' : ''}`,
          data: {
            categoryId: parseInt(categoryId),
            action: 'deleted',
            affectedProducts: activeProductsCount,
            affectedSubcategories: activeSubcategoriesCount
          }
        });
      });

    } catch (error) {
      logger.error('Delete category error:', error.message);
      res.status(400).json({
        success: false,
        message: error.message || 'Failed to delete category'
      });
    }
  }

  /**
   * Get category hierarchy tree
   */
  static async getCategoryHierarchy(req, res) {
    try {
      const { rootOnly = 'false', includeInactive = 'false' } = req.query;

      let whereClause = '';
      const queryParams = [];

      if (includeInactive !== 'true') {
        whereClause = 'WHERE is_active = TRUE';
      }

      const hierarchyQuery = `
        SELECT 
          category_id, category_name, description, parent_category_id, is_active,
          (SELECT COUNT(*) FROM products WHERE category_id = c.category_id AND is_active = TRUE) as product_count
        FROM categories c
        ${whereClause}
        ORDER BY category_name
      `;

      const result = await query(hierarchyQuery, queryParams);

      let categories = result.rows.map(category => ({
        id: category.category_id,
        name: category.category_name,
        description: category.description,
        parentCategoryId: category.parent_category_id,
        productCount: parseInt(category.product_count),
        isActive: category.is_active
      }));

      // Build hierarchy tree
      const hierarchy = buildCategoryHierarchy(categories, rootOnly === 'true');

      res.json({
        success: true,
        data: {
          hierarchy,
          totalCategories: categories.length
        }
      });

    } catch (error) {
      logger.error('Get category hierarchy error:', error.message);
      res.status(500).json({
        success: false,
        message: 'Failed to retrieve category hierarchy'
      });
    }
  }

  /**
   * Get categories statistics
   */
  static async getCategoryStatistics(req, res) {
    try {
      const statsQuery = `
        SELECT 
          COUNT(*) as total_categories,
          COUNT(*) FILTER (WHERE is_active = TRUE) as active_categories,
          COUNT(*) FILTER (WHERE parent_category_id IS NULL) as root_categories,
          COUNT(*) FILTER (WHERE parent_category_id IS NOT NULL) as subcategories
        FROM categories
      `;

      const productStatsQuery = `
        SELECT 
          c.category_id,
          c.category_name,
          COUNT(p.product_id) as product_count,
          COUNT(p.product_id) FILTER (WHERE p.is_active = TRUE) as active_product_count,
          COALESCE(SUM(i.quantity_on_hand), 0) as total_inventory
        FROM categories c
        LEFT JOIN products p ON c.category_id = p.category_id
        LEFT JOIN inventory i ON p.product_id = i.product_id AND i.status = 'active'
        WHERE c.is_active = TRUE
        GROUP BY c.category_id, c.category_name
        HAVING COUNT(p.product_id) > 0
        ORDER BY product_count DESC
        LIMIT 10
      `;

      const [statsResult, productStatsResult] = await Promise.all([
        query(statsQuery),
        query(productStatsQuery)
      ]);

      const stats = statsResult.rows[0];

      res.json({
        success: true,
        data: {
          overview: {
            totalCategories: parseInt(stats.total_categories),
            activeCategories: parseInt(stats.active_categories),
            rootCategories: parseInt(stats.root_categories),
            subcategories: parseInt(stats.subcategories)
          },
          topCategoriesByProducts: productStatsResult.rows.map(cat => ({
            id: cat.category_id,
            name: cat.category_name,
            productCount: parseInt(cat.product_count),
            activeProductCount: parseInt(cat.active_product_count),
            totalInventory: parseInt(cat.total_inventory)
          }))
        }
      });

    } catch (error) {
      logger.error('Get category statistics error:', error.message);
      res.status(500).json({
        success: false,
        message: 'Failed to retrieve category statistics'
      });
    }
  }
}

/**
 * Helper function to build category hierarchy
 */
function buildCategoryHierarchy(categories, rootOnly = false) {
  const categoryMap = new Map();
  const rootCategories = [];

  // Create a map for quick lookup
  categories.forEach(category => {
    categoryMap.set(category.id, { ...category, children: [] });
  });

  // Build the hierarchy
  categories.forEach(category => {
    const categoryNode = categoryMap.get(category.id);
    
    if (category.parentCategoryId) {
      const parent = categoryMap.get(category.parentCategoryId);
      if (parent) {
        parent.children.push(categoryNode);
      } else {
        // Parent not found (inactive or deleted), treat as root
        rootCategories.push(categoryNode);
      }
    } else {
      rootCategories.push(categoryNode);
    }
  });

  return rootOnly ? rootCategories : Array.from(categoryMap.values());
}

module.exports = CategoryController;
