const { query, transaction } = require('../config/database');
const logger = require('../utils/logger');
const { validateEmail } = require('../utils/helpers');

class CustomerController {
  /**
   * Register a new customer
   */
  static async createCustomer(req, res) {
    try {
      const {
        firstName,
        lastName,
        phone,
        email,
        dateOfBirth,
        address,
        city,
        state,
        postalCode,
        insuranceProvider,
        insuranceId,
        allergies,
        medicalConditions,
        emergencyContactName,
        emergencyContactPhone
      } = req.body;

      // Input validation
      if (!firstName || !lastName) {
        return res.status(400).json({
          success: false,
          message: 'First name and last name are required'
        });
      }

      // Validate email format if provided
      if (email && !validateEmail(email)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid email format'
        });
      }

      // Validate date of birth if provided
      if (dateOfBirth) {
        const dob = new Date(dateOfBirth);
        const today = new Date();
        if (dob > today) {
          return res.status(400).json({
            success: false,
            message: 'Date of birth cannot be in the future'
          });
        }
      }

      await transaction(async (client) => {
        // Check if customer with same phone or email already exists
        if (phone || email) {
          const duplicateCheckQuery = `
            SELECT customer_id, phone, email 
            FROM customers 
            WHERE (phone = $1 AND phone IS NOT NULL) OR (email = $2 AND email IS NOT NULL)
          `;
          const duplicateCheck = await client.query(duplicateCheckQuery, [phone, email]);

          if (duplicateCheck.rows.length > 0) {
            const existing = duplicateCheck.rows[0];
            const field = existing.phone === phone ? 'phone number' : 'email';
            throw new Error(`Customer with this ${field} already exists`);
          }
        }

        // Insert new customer
        const insertCustomerQuery = `
          INSERT INTO customers (
            first_name, last_name, phone, email, date_of_birth, address, city, state, 
            postal_code, insurance_provider, insurance_id, allergies, medical_conditions,
            emergency_contact_name, emergency_contact_phone
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
          RETURNING customer_id, customer_code, first_name, last_name, phone, email, 
                   date_of_birth, created_at
        `;

        const result = await client.query(insertCustomerQuery, [
          firstName, lastName, phone, email, dateOfBirth, address, city, state,
          postalCode, insuranceProvider, insuranceId, allergies, medicalConditions,
          emergencyContactName, emergencyContactPhone
        ]);

        const newCustomer = result.rows[0];

        logger.info('New customer registered', {
          customerId: newCustomer.customer_id,
          customerCode: newCustomer.customer_code,
          name: `${newCustomer.first_name} ${newCustomer.last_name}`,
          createdBy: req.user?.userId
        });

        res.status(201).json({
          success: true,
          message: 'Customer registered successfully',
          data: {
            customer: {
              id: newCustomer.customer_id,
              customerCode: newCustomer.customer_code,
              firstName: newCustomer.first_name,
              lastName: newCustomer.last_name,
              phone: newCustomer.phone,
              email: newCustomer.email,
              dateOfBirth: newCustomer.date_of_birth,
              createdAt: newCustomer.created_at
            }
          }
        });
      });

    } catch (error) {
      logger.error('Create customer error:', error.message);
      res.status(400).json({
        success: false,
        message: error.message || 'Failed to create customer'
      });
    }
  }

  /**
   * Get customer by ID with full profile
   */
  static async getCustomerById(req, res) {
    try {
      const { customerId } = req.params;

      const customerQuery = `
        SELECT 
          customer_id, customer_code, first_name, last_name, phone, email, 
          date_of_birth, address, city, state, postal_code, insurance_provider, 
          insurance_id, allergies, medical_conditions, emergency_contact_name, 
          emergency_contact_phone, is_active, created_at, updated_at
        FROM customers 
        WHERE customer_id = $1
      `;

      const customerResult = await query(customerQuery, [customerId]);

      if (customerResult.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'Customer not found'
        });
      }

      const customer = customerResult.rows[0];

      // Get customer's recent purchases count and last purchase date
      const purchaseStatsQuery = `
        SELECT 
          COUNT(*) as total_purchases,
          SUM(total_amount) as total_spent,
          MAX(sale_date) as last_purchase_date
        FROM sales 
        WHERE customer_id = $1 AND payment_status IN ('completed', 'partial')
      `;

      const purchaseStats = await query(purchaseStatsQuery, [customerId]);
      const stats = purchaseStats.rows[0];

      res.json({
        success: true,
        data: {
          customer: {
            id: customer.customer_id,
            customerCode: customer.customer_code,
            firstName: customer.first_name,
            lastName: customer.last_name,
            fullName: `${customer.first_name} ${customer.last_name}`,
            phone: customer.phone,
            email: customer.email,
            dateOfBirth: customer.date_of_birth,
            address: {
              street: customer.address,
              city: customer.city,
              state: customer.state,
              postalCode: customer.postal_code
            },
            insurance: {
              provider: customer.insurance_provider,
              id: customer.insurance_id
            },
            medical: {
              allergies: customer.allergies,
              conditions: customer.medical_conditions
            },
            emergencyContact: {
              name: customer.emergency_contact_name,
              phone: customer.emergency_contact_phone
            },
            purchaseHistory: {
              totalPurchases: parseInt(stats.total_purchases),
              totalSpent: parseFloat(stats.total_spent || 0),
              lastPurchaseDate: stats.last_purchase_date
            },
            isActive: customer.is_active,
            createdAt: customer.created_at,
            updatedAt: customer.updated_at
          }
        }
      });

    } catch (error) {
      logger.error('Get customer error:', error.message);
      res.status(500).json({
        success: false,
        message: 'Failed to retrieve customer'
      });
    }
  }

  /**
   * Get customers list with pagination and search
   */
  static async getCustomers(req, res) {
    try {
      const {
        page = 1,
        limit = 20,
        search,
        isActive = 'true',
        hasInsurance,
        city,
        state
      } = req.query;

      const offset = (page - 1) * limit;
      const queryParams = [];
      let whereClause = 'WHERE 1=1';
      let paramCounter = 1;

      // Build dynamic WHERE clause
      if (isActive !== 'all') {
        whereClause += ` AND is_active = $${paramCounter}`;
        queryParams.push(isActive === 'true');
        paramCounter++;
      }

      if (search) {
        whereClause += ` AND (
          first_name ILIKE $${paramCounter} OR 
          last_name ILIKE $${paramCounter} OR 
          customer_code ILIKE $${paramCounter} OR
          phone ILIKE $${paramCounter} OR
          email ILIKE $${paramCounter}
        )`;
        queryParams.push(`%${search}%`);
        paramCounter++;
      }

      if (hasInsurance === 'true') {
        whereClause += ` AND insurance_provider IS NOT NULL`;
      } else if (hasInsurance === 'false') {
        whereClause += ` AND insurance_provider IS NULL`;
      }

      if (city) {
        whereClause += ` AND city ILIKE $${paramCounter}`;
        queryParams.push(`%${city}%`);
        paramCounter++;
      }

      if (state) {
        whereClause += ` AND state ILIKE $${paramCounter}`;
        queryParams.push(`%${state}%`);
        paramCounter++;
      }

      // Get total count
      const countQuery = `
        SELECT COUNT(*) as total
        FROM customers 
        ${whereClause}
      `;

      const countResult = await query(countQuery, queryParams);
      const total = parseInt(countResult.rows[0].total);

      // Get customers data with purchase stats
      const customersQuery = `
        SELECT 
          c.customer_id, c.customer_code, c.first_name, c.last_name, c.phone, 
          c.email, c.city, c.state, c.insurance_provider, c.is_active, c.created_at,
          COUNT(s.sale_id) as total_purchases,
          SUM(s.total_amount) as total_spent,
          MAX(s.sale_date) as last_purchase_date
        FROM customers c
        LEFT JOIN sales s ON c.customer_id = s.customer_id AND s.payment_status IN ('completed', 'partial')
        ${whereClause}
        GROUP BY c.customer_id
        ORDER BY c.created_at DESC
        LIMIT $${paramCounter} OFFSET $${paramCounter + 1}
      `;

      queryParams.push(limit, offset);
      const customersResult = await query(customersQuery, queryParams);

      const totalPages = Math.ceil(total / limit);

      res.json({
        success: true,
        data: {
          customers: customersResult.rows.map(customer => ({
            id: customer.customer_id,
            customerCode: customer.customer_code,
            firstName: customer.first_name,
            lastName: customer.last_name,
            fullName: `${customer.first_name} ${customer.last_name}`,
            phone: customer.phone,
            email: customer.email,
            location: customer.city && customer.state ? `${customer.city}, ${customer.state}` : null,
            hasInsurance: !!customer.insurance_provider,
            totalPurchases: parseInt(customer.total_purchases),
            totalSpent: parseFloat(customer.total_spent || 0),
            lastPurchaseDate: customer.last_purchase_date,
            isActive: customer.is_active,
            createdAt: customer.created_at
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
      logger.error('Get customers error:', error.message);
      res.status(500).json({
        success: false,
        message: 'Failed to retrieve customers'
      });
    }
  }

  /**
   * Update customer information
   */
  static async updateCustomer(req, res) {
    try {
      const { customerId } = req.params;
      const {
        firstName,
        lastName,
        phone,
        email,
        dateOfBirth,
        address,
        city,
        state,
        postalCode,
        insuranceProvider,
        insuranceId,
        allergies,
        medicalConditions,
        emergencyContactName,
        emergencyContactPhone
      } = req.body;

      // Validate email format if provided
      if (email && !validateEmail(email)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid email format'
        });
      }

      // Validate date of birth if provided
      if (dateOfBirth) {
        const dob = new Date(dateOfBirth);
        const today = new Date();
        if (dob > today) {
          return res.status(400).json({
            success: false,
            message: 'Date of birth cannot be in the future'
          });
        }
      }

      await transaction(async (client) => {
        // Check if customer exists
        const existsQuery = `SELECT customer_id FROM customers WHERE customer_id = $1`;
        const existsResult = await client.query(existsQuery, [customerId]);

        if (existsResult.rows.length === 0) {
          throw new Error('Customer not found');
        }

        // Check for duplicate phone or email (excluding current customer)
        if (phone || email) {
          const duplicateCheckQuery = `
            SELECT customer_id, phone, email 
            FROM customers 
            WHERE customer_id != $1 AND (
              (phone = $2 AND phone IS NOT NULL) OR 
              (email = $3 AND email IS NOT NULL)
            )
          `;
          const duplicateCheck = await client.query(duplicateCheckQuery, [customerId, phone, email]);

          if (duplicateCheck.rows.length > 0) {
            const existing = duplicateCheck.rows[0];
            const field = existing.phone === phone ? 'phone number' : 'email';
            throw new Error(`Another customer with this ${field} already exists`);
          }
        }

        // Update customer
        const updateQuery = `
          UPDATE customers 
          SET 
            first_name = COALESCE($1, first_name),
            last_name = COALESCE($2, last_name),
            phone = COALESCE($3, phone),
            email = COALESCE($4, email),
            date_of_birth = COALESCE($5, date_of_birth),
            address = COALESCE($6, address),
            city = COALESCE($7, city),
            state = COALESCE($8, state),
            postal_code = COALESCE($9, postal_code),
            insurance_provider = COALESCE($10, insurance_provider),
            insurance_id = COALESCE($11, insurance_id),
            allergies = COALESCE($12, allergies),
            medical_conditions = COALESCE($13, medical_conditions),
            emergency_contact_name = COALESCE($14, emergency_contact_name),
            emergency_contact_phone = COALESCE($15, emergency_contact_phone),
            updated_at = NOW()
          WHERE customer_id = $16
          RETURNING customer_id, customer_code, first_name, last_name, phone, email, 
                   date_of_birth, address, city, state, postal_code, insurance_provider, 
                   insurance_id, updated_at
        `;

        const result = await client.query(updateQuery, [
          firstName, lastName, phone, email, dateOfBirth, address, city, state,
          postalCode, insuranceProvider, insuranceId, allergies, medicalConditions,
          emergencyContactName, emergencyContactPhone, customerId
        ]);

        const updatedCustomer = result.rows[0];

        logger.info('Customer updated', {
          customerId: updatedCustomer.customer_id,
          customerCode: updatedCustomer.customer_code,
          updatedBy: req.user?.userId
        });

        res.json({
          success: true,
          message: 'Customer updated successfully',
          data: {
            customer: {
              id: updatedCustomer.customer_id,
              customerCode: updatedCustomer.customer_code,
              firstName: updatedCustomer.first_name,
              lastName: updatedCustomer.last_name,
              phone: updatedCustomer.phone,
              email: updatedCustomer.email,
              dateOfBirth: updatedCustomer.date_of_birth,
              address: {
                street: updatedCustomer.address,
                city: updatedCustomer.city,
                state: updatedCustomer.state,
                postalCode: updatedCustomer.postal_code
              },
              insurance: {
                provider: updatedCustomer.insurance_provider,
                id: updatedCustomer.insurance_id
              },
              updatedAt: updatedCustomer.updated_at
            }
          }
        });
      });

    } catch (error) {
      logger.error('Update customer error:', error.message);
      res.status(400).json({
        success: false,
        message: error.message || 'Failed to update customer'
      });
    }
  }

  /**
   * Deactivate/reactivate customer
   */
  static async toggleCustomerStatus(req, res) {
    try {
      const { customerId } = req.params;
      const { isActive, reason } = req.body;

      if (typeof isActive !== 'boolean') {
        return res.status(400).json({
          success: false,
          message: 'isActive must be a boolean value'
        });
      }

      await transaction(async (client) => {
        // Check if customer exists
        const customerQuery = `
          SELECT customer_id, customer_code, first_name, last_name, is_active 
          FROM customers 
          WHERE customer_id = $1
        `;
        const customerResult = await client.query(customerQuery, [customerId]);

        if (customerResult.rows.length === 0) {
          throw new Error('Customer not found');
        }

        const customer = customerResult.rows[0];

        if (customer.is_active === isActive) {
          const action = isActive ? 'already active' : 'already inactive';
          throw new Error(`Customer is ${action}`);
        }

        // Update customer status
        const updateQuery = `
          UPDATE customers 
          SET is_active = $1, updated_at = NOW()
          WHERE customer_id = $2
          RETURNING is_active, updated_at
        `;

        const result = await client.query(updateQuery, [isActive, customerId]);
        const updated = result.rows[0];

        const action = isActive ? 'reactivated' : 'deactivated';
        logger.info(`Customer ${action}`, {
          customerId,
          customerCode: customer.customer_code,
          reason: reason || 'No reason provided',
          performedBy: req.user?.userId
        });

        res.json({
          success: true,
          message: `Customer ${action} successfully`,
          data: {
            customerId,
            isActive: updated.is_active,
            updatedAt: updated.updated_at
          }
        });
      });

    } catch (error) {
      logger.error('Toggle customer status error:', error.message);
      res.status(400).json({
        success: false,
        message: error.message || 'Failed to update customer status'
      });
    }
  }

  /**
   * Get customer's prescription history
   */
  static async getCustomerPrescriptions(req, res) {
    try {
      const { customerId } = req.params;
      const { page = 1, limit = 10, startDate, endDate } = req.query;

      const offset = (page - 1) * limit;
      const queryParams = [customerId];
      let whereClause = 'WHERE s.customer_id = $1 AND s.prescription_number IS NOT NULL';
      let paramCounter = 2;

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

      // Get total count
      const countQuery = `
        SELECT COUNT(*) as total
        FROM sales s
        ${whereClause}
      `;

      const countResult = await query(countQuery, queryParams);
      const total = parseInt(countResult.rows[0].total);

      // Get prescriptions
      const prescriptionsQuery = `
        SELECT 
          s.sale_id, s.sale_number, s.sale_date, s.prescription_number, 
          s.doctor_name, s.total_amount, s.insurance_claim_amount,
          s.customer_payment_amount, s.payment_status,
          STRING_AGG(
            DISTINCT CONCAT(p.product_name, ' (', si.quantity, ')'), 
            ', ' ORDER BY p.product_name
          ) as medications
        FROM sales s
        JOIN sale_items si ON s.sale_id = si.sale_id
        JOIN products p ON si.product_id = p.product_id
        ${whereClause}
        GROUP BY s.sale_id
        ORDER BY s.sale_date DESC
        LIMIT $${paramCounter} OFFSET $${paramCounter + 1}
      `;

      queryParams.push(limit, offset);
      const prescriptionsResult = await query(prescriptionsQuery, queryParams);

      const totalPages = Math.ceil(total / limit);

      res.json({
        success: true,
        data: {
          prescriptions: prescriptionsResult.rows.map(prescription => ({
            saleId: prescription.sale_id,
            saleNumber: prescription.sale_number,
            prescriptionNumber: prescription.prescription_number,
            saleDate: prescription.sale_date,
            doctorName: prescription.doctor_name,
            medications: prescription.medications,
            totalAmount: parseFloat(prescription.total_amount),
            insuranceClaimAmount: parseFloat(prescription.insurance_claim_amount),
            customerPaymentAmount: parseFloat(prescription.customer_payment_amount),
            paymentStatus: prescription.payment_status
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
      logger.error('Get customer prescriptions error:', error.message);
      res.status(500).json({
        success: false,
        message: 'Failed to retrieve prescription history'
      });
    }
  }

  /**
   * Get customer's purchase history
   */
  static async getCustomerPurchaseHistory(req, res) {
    try {
      const { customerId } = req.params;
      const { page = 1, limit = 10, startDate, endDate } = req.query;

      const offset = (page - 1) * limit;
      const queryParams = [customerId];
      let whereClause = 'WHERE s.customer_id = $1';
      let paramCounter = 2;

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

      // Get total count
      const countQuery = `
        SELECT COUNT(*) as total
        FROM sales s
        ${whereClause}
      `;

      const countResult = await query(countQuery, queryParams);
      const total = parseInt(countResult.rows[0].total);

      // Get purchase history
      const purchasesQuery = `
        SELECT 
          s.sale_id, s.sale_number, s.sale_date, s.subtotal, s.tax_amount,
          s.discount_amount, s.total_amount, s.payment_method, s.payment_status,
          s.prescription_number, s.doctor_name,
          COUNT(si.sale_item_id) as item_count,
          STRING_AGG(
            DISTINCT p.product_name, 
            ', ' ORDER BY p.product_name
          ) as products
        FROM sales s
        LEFT JOIN sale_items si ON s.sale_id = si.sale_id
        LEFT JOIN products p ON si.product_id = p.product_id
        ${whereClause}
        GROUP BY s.sale_id
        ORDER BY s.sale_date DESC
        LIMIT $${paramCounter} OFFSET $${paramCounter + 1}
      `;

      queryParams.push(limit, offset);
      const purchasesResult = await query(purchasesQuery, queryParams);

      const totalPages = Math.ceil(total / limit);

      res.json({
        success: true,
        data: {
          purchases: purchasesResult.rows.map(purchase => ({
            saleId: purchase.sale_id,
            saleNumber: purchase.sale_number,
            saleDate: purchase.sale_date,
            subtotal: parseFloat(purchase.subtotal),
            taxAmount: parseFloat(purchase.tax_amount),
            discountAmount: parseFloat(purchase.discount_amount),
            totalAmount: parseFloat(purchase.total_amount),
            paymentMethod: purchase.payment_method,
            paymentStatus: purchase.payment_status,
            prescriptionNumber: purchase.prescription_number,
            doctorName: purchase.doctor_name,
            itemCount: parseInt(purchase.item_count),
            products: purchase.products
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
      logger.error('Get customer purchase history error:', error.message);
      res.status(500).json({
        success: false,
        message: 'Failed to retrieve purchase history'
      });
    }
  }

  /**
   * Search customers (for quick lookup during sales)
   */
  static async searchCustomers(req, res) {
    try {
      const { q, limit = 10 } = req.query;

      if (!q || q.trim().length < 2) {
        return res.status(400).json({
          success: false,
          message: 'Search query must be at least 2 characters'
        });
      }

      const searchQuery = `
        SELECT 
          customer_id, customer_code, first_name, last_name, phone, email,
          city, state, insurance_provider
        FROM customers 
        WHERE is_active = TRUE AND (
          first_name ILIKE $1 OR 
          last_name ILIKE $1 OR 
          customer_code ILIKE $1 OR
          phone ILIKE $1 OR
          email ILIKE $1 OR
          CONCAT(first_name, ' ', last_name) ILIKE $1
        )
        ORDER BY 
          CASE 
            WHEN customer_code ILIKE $1 THEN 1
            WHEN phone ILIKE $1 THEN 2
            WHEN CONCAT(first_name, ' ', last_name) ILIKE $1 THEN 3
            ELSE 4
          END,
          first_name, last_name
        LIMIT $2
      `;

      const searchTerm = `%${q.trim()}%`;
      const result = await query(searchQuery, [searchTerm, limit]);

      res.json({
        success: true,
        data: {
          customers: result.rows.map(customer => ({
            id: customer.customer_id,
            customerCode: customer.customer_code,
            firstName: customer.first_name,
            lastName: customer.last_name,
            fullName: `${customer.first_name} ${customer.last_name}`,
            phone: customer.phone,
            email: customer.email,
            location: customer.city && customer.state ? `${customer.city}, ${customer.state}` : null,
            hasInsurance: !!customer.insurance_provider
          })),
          query: q,
          resultCount: result.rows.length
        }
      });

    } catch (error) {
      logger.error('Search customers error:', error.message);
      res.status(500).json({
        success: false,
        message: 'Failed to search customers'
      });
    }
  }
}

module.exports = CustomerController;
