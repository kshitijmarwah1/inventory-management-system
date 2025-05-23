'use strict';

const { Pool } = require('pg');
const dotenv = require('dotenv');
dotenv.config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const fetch = require('node-fetch');
const app = express();
const PORT = process.env.PG_PORT || 5432;

// Enable CORS and JSON parsing
app.use(cors());
app.use(express.json());

const connectionString = `postgres://${process.env.PG_USER}:${process.env.PG_PASSWORD}@${process.env.PG_HOST}:${process.env.PG_PORT}/${process.env.PG_DATABASE}?sslmode=require`;

const pool = new Pool({
  connectionString: connectionString,
  ssl: { rejectUnauthorized: false },
  max: 3,
});

// Connect to MySQL and create tables if they don't exist
// Use promise wrapper for sequential queries
async function initializeDatabase() {
  try {
    // Test connection
    await pool.query('SELECT 1');
    console.log('Connected to PostgreSQL database');

    // Create the users table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(255) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        email VARCHAR(255) NOT NULL
      )
    `);
    console.log('Users table is ready');

    // Create categories table (needed before products)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS categories (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        description TEXT,
        product_ids VARCHAR(255),
        user_id INT NOT NULL
      )
    `);
    console.log('Categories table is ready');
    // Create customers table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS customers (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        customer_number VARCHAR(255) NOT NULL,
        email VARCHAR(255),
        user_id INT NOT NULL
      )
    `);
    console.log('Customers table is ready');

    // Create Products Table (with user_id)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS products (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        quantity INT DEFAULT 0,
        price NUMERIC(10,2) NOT NULL,
        category_id INT,
        user_id INT NOT NULL,
        FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL
      )
    `);
    console.log('Products table is ready');

    // Create Orders Table (with user_id)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS orders (
        id SERIAL PRIMARY KEY,
        customer_id INT,
        order_date DATE DEFAULT CURRENT_DATE,
        order_value NUMERIC(10,2),
        user_id INT NOT NULL,
        FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE SET NULL
      )
    `);
    console.log('Orders table is ready');

    // Create Order_items Table (with user_id)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS order_items (
        id SERIAL PRIMARY KEY,
        order_id INT,
        product_id INT,
        quantity INT,
        user_id INT NOT NULL,
        FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
        FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
      )
    `);
    console.log('Order_items table is ready');

    // Create Vendors Table
    await pool.query(`
  CREATE TABLE IF NOT EXISTS vendors (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    email VARCHAR(255),
    supply_area VARCHAR(255),
    phone VARCHAR(20),
    user_id INT NOT NULL
  )
`);
    console.log('Vendors table is ready');

    // Create product_history table
    await pool.query(`
  CREATE TABLE IF NOT EXISTS product_history (
    id SERIAL PRIMARY KEY,
    product_id INT NOT NULL,
    product_name VARCHAR(255),
    change_type VARCHAR(50) NOT NULL,
    change_details TEXT,
    changed_at TIMESTAMPZ DEFAULT NOW(),
    user_id INT NOT NULL,
    FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
  )
`);
    console.log('Product_history table is ready');
  } catch (err) {
    console.error('Error initializing database:', err);
  }
}

initializeDatabase();

// Helper: Log product history
async function logProductHistory(
  product_id,
  product_name,
  change_type,
  change_details,
  user_id,
) {
  try {
    await pool.query(
      `INSERT INTO product_history (product_id, product_name, change_type, change_details, user_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [product_id, product_name, change_type, change_details, user_id],
    );
    console.log(
      `Product history logged for product_id: ${product_id}, action: ${change_type}`,
    );
  } catch (err) {
    console.error('Error logging product history:', err);
  }
}

/* --------------------
   AUTHENTICATION ENDPOINTS
-------------------- */

// Signup Endpoint
app.post('/api/signup', async (req, res) => {
  const { username, email, password } = req.body;
  if (!username || !email || !password) {
    return res.status(400).json({
      success: false,
      message: 'Username, email, and password are required.',
    });
  }

  // Basic server-side email validation
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return res
      .status(400)
      .json({ success: false, message: 'Invalid email format.' });
  }

  // Password validation: Minimum 8 characters, with uppercase, lowercase, digit, special character
  const passwordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[\W_]).{8,}$/;
  if (!passwordRegex.test(password)) {
    return res.status(400).json({
      success: false,
      message:
        'Password must be at least 8 characters long and include uppercase, lowercase, a number, and a special character.',
    });
  }

  try {
    const hash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      'INSERT INTO users (username, email, password) VALUES ($1, $2, $3) RETURNING id, username, email',
      [username, email, hash],
    );
    res.json({ success: true, user: result.rows[0] });
  } catch (err) {
    console.error('Error during signup:', err);
    res.status(500).json({ success: false, message: 'Signup failed.' });
  }
});

// Login Endpoint
app.post('/api/login', async (req, res) => {
  let { username, password } = req.body;
  if (!username || !password)
    return res
      .status(400)
      .json({ success: false, message: 'Username and password are required.' });
  username = username.trim();
  password = password.trim();
  try {
    const result = await pool.query('SELECT * FROM users WHERE username = $1', [
      username,
    ]);
    if (result.rowCount === 0) {
      console.error('No user found for username:', username);
      return res
        .status(400)
        .json({ success: false, message: 'Invalid credentials.' });
    }
    const user = result.rows[0];
    const match = await bcrypt.compare(password, user.password);
    if (!match) {
      console.error('Password mismatch for user:', username);
      return res
        .status(400)
        .json({ success: false, message: 'Invalid credentials.' });
    }
    res.json({ success: true, user: { id: user.id, username: user.username } });
  } catch (err) {
    console.error('Error during login:', err);
    res.status(500).json({ success: false, message: 'Login failed.' });
  }
});

// Middleware to require user identification in header (x-user-id)
function requireUser(req, res, next) {
  const userId = req.headers['x-user-id'];
  if (!userId) {
    return res.status(400).json({
      success: false,
      message: 'User ID is required in header (x-user-id).',
    });
  }
  req.userId = userId;
  next();
}

/* ---------- PRODUCTS API ---------- */
app.get('/api/products', requireUser, async (req, res) => {
  const userId = req.userId;
  try {
    const result = await pool.query(
      `SELECT p.*, c.name AS category_name
       FROM products p
       LEFT JOIN categories c ON p.category_id = c.id
       WHERE p.user_id = $1`,
      [userId],
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching products:', err);
    res.status(500).send('Error fetching products');
  }
});

app.post('/api/products', requireUser, async (req, res) => {
  const userId = req.userId;
  const { name, quantity, price, category_id } = req.body;
  if (isNaN(price)) return res.status(400).send('Price must be a valid number');
  try {
    await pool.query(
      'INSERT INTO products (name, quantity, price, category_id, user_id) VALUES ($1, $2, $3, $4, $5)',
      [name, quantity, price, category_id || null, userId],
    );
    const result = await pool.query(
      `SELECT p.*, c.name AS category_name
       FROM products p
       LEFT JOIN categories c ON p.category_id = c.id
       WHERE p.user_id = $1
       ORDER BY p.id DESC
       LIMIT 1`,
      [userId],
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Error adding product:', err);
    res.status(500).send('Error adding product');
  }
});

app.put('/api/products/:id', requireUser, async (req, res) => {
  const userId = req.userId;
  const { id } = req.params;
  const { name, quantity, price, category_id } = req.body;
  try {
    const result = await pool.query(
      'UPDATE products SET name = $1, quantity = $2, price = $3, category_id = $4 WHERE id = $5 AND user_id = $6 RETURNING *',
      [name, quantity, price, category_id || null, id, userId],
    );
    if (result.rowCount === 0) return res.status(404).send('Product not found');

    await logProductHistory(
      id,
      name, // Updated product name
      'Product Updated',
      JSON.stringify({ name, quantity, price, category_id }),
      userId,
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error updating product:', err);
    res.status(500).send('Error updating product');
  }
});

app.delete('/api/products/:id', requireUser, async (req, res) => {
  const userId = req.userId;
  const { id } = req.params;
  const productResult = await pool.query(
    'SELECT name FROM products WHERE id = $1 AND user_id = $2',
    [id, userId],
  );
  const productName =
    productResult.rowCount > 0 ? productResult.rows[0].name : 'Unknown';
  try {
    await pool.query(
      'DELETE FROM order_items WHERE product_id = $1 AND user_id = $2',
      [id, userId],
    );
    const result = await pool.query(
      'DELETE FROM products WHERE id = $1 AND user_id = $2',
      [id, userId],
    );
    if (result.rowCount === 0) return res.status(404).send('Product not found');
    await logProductHistory(
      id,
      productName,
      'Product Deleted',
      'Product was deleted',
      userId,
    );
    res.json({
      message: 'Product and associated order items deleted successfully',
    });
  } catch (err) {
    console.error('Error deleting product:', err);
    res.status(500).send('Error deleting product');
  }
});

app.get('/api/products/:id/history', requireUser, async (req, res) => {
  const userId = req.userId;
  const productId = req.params.id;
  try {
    const result = await pool.query(
      'SELECT id, change_type, change_details, changed_at FROM product_history WHERE product_id = $1 AND user_id = $2 ORDER BY changed_at DESC',
      [productId, userId],
    );
    res.json({ success: true, history: result.rows });
  } catch (err) {
    console.error('Error fetching product history:', err);
    res
      .status(500)
      .json({ success: false, message: 'Error fetching product history' });
  }
});

/* ---------- CATEGORIES API ---------- */
app.get('/api/categories', requireUser, async (req, res) => {
  const userId = req.userId;
  try {
    const result = await pool.query(
      `SELECT 
         c.id AS category_id,
         c.name AS category_name,
         c.description,
         COALESCE(
           '[' || STRING_AGG(
             '{"id":' || p.id || ',"name":"' || p.name || '","price":' || p.price || ',"quantity":' || p.quantity || '}',
             ','
           ) || ']',
           '[]'
         ) AS products
       FROM categories c
       LEFT JOIN products p ON c.id = p.category_id AND p.user_id = $1
       WHERE c.user_id = $2
       GROUP BY c.id`,
      [userId, userId],
    );
    const categories = result.rows.map((row) => ({
      id: row.category_id,
      name: row.category_name,
      description: row.description,
      products: JSON.parse(row.products),
    }));
    res.json(categories);
  } catch (err) {
    console.error('Error fetching categories:', err);
    res.status(500).send('Error fetching categories');
  }
});

app.post('/api/categories', requireUser, async (req, res) => {
  const userId = req.userId;
  const { name, description, product_ids } = req.body;
  try {
    const result = await pool.query(
      'INSERT INTO categories (name, description, product_ids, user_id) VALUES ($1, $2, $3, $4) RETURNING *',
      [name, description, product_ids, userId],
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Error adding category:', err);
    res.status(500).send('Error adding category');
  }
});

app.put('/api/categories/:id', requireUser, async (req, res) => {
  const userId = req.userId;
  const { id } = req.params;
  const { name, description, product_ids } = req.body;
  try {
    const result = await pool.query(
      'UPDATE categories SET name = $1, description = $2, product_ids = $3 WHERE id = $4 AND user_id = $5',
      [name, description, product_ids, id, userId],
    );
    if (result.rowCount === 0)
      return res.status(404).send('Category not found');
    res.json({ id, name, description, product_ids });
  } catch (err) {
    console.error('Error updating category:', err);
    res.status(500).send('Error updating category');
  }
});

app.delete('/api/categories/:id', requireUser, async (req, res) => {
  const userId = req.userId;
  const { id } = req.params;
  try {
    const result = await pool.query(
      'DELETE FROM categories WHERE id = $1 AND user_id = $2',
      [id, userId],
    );
    if (result.rowCount === 0)
      return res.status(404).send('Category not found');
    res.json({ message: 'Category deleted successfully' });
  } catch (err) {
    console.error('Error deleting category:', err);
    res.status(500).send('Error deleting category');
  }
});

/* ---------- CUSTOMERS API ---------- */
// Get all customers
app.get('/api/customers', requireUser, async (req, res) => {
  const userId = req.userId;
  try {
    const result = await pool.query(
      `SELECT 
         cu.id,
         cu.name,
         cu.customer_number,
         cu.email,
         (SELECT STRING_AGG(o.id::text, ',') FROM orders o WHERE o.customer_id = cu.id AND o.user_id = $1) AS orders
       FROM customers cu WHERE cu.user_id = $2`,
      [userId, userId],
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching customers:', err);
    res.status(500).send('Error fetching customers');
  }
});

app.post('/api/customers', requireUser, async (req, res) => {
  const userId = req.userId;
  const { name, customer_number, email } = req.body;
  if (!name || !customer_number) {
    return res.status(400).send('Name and Customer Number are required');
  }
  try {
    const result = await pool.query(
      'INSERT INTO customers (name, customer_number, email, user_id) VALUES ($1, $2, $3, $4) RETURNING *',
      [name, customer_number, email || null, userId],
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Error adding customer:', err);
    res.status(500).send('Error adding customer');
  }
});

app.put('/api/customers/:id', requireUser, async (req, res) => {
  const userId = req.userId;
  const { id } = req.params;
  const { name, customer_number, email } = req.body;
  if (!name || !customer_number) {
    return res.status(400).send('Name and Customer Number are required');
  }
  try {
    const result = await pool.query(
      'UPDATE customers SET name = $1, customer_number = $2, email = $3 WHERE id = $4 AND user_id = $5',
      [name, customer_number, email || null, id, userId],
    );
    if (result.rowCount === 0)
      return res.status(404).send('Customer not found');
    res.json({ id, name, customer_number, email });
  } catch (err) {
    console.error('Error updating customer:', err);
    res.status(500).send('Error updating customer');
  }
});

app.delete('/api/customers/:id', requireUser, async (req, res) => {
  const userId = req.userId;
  const { id } = req.params;
  try {
    const result = await pool.query(
      'DELETE FROM customers WHERE id = $1 AND user_id = $2',
      [id, userId],
    );
    if (result.rowCount === 0)
      return res.status(404).send('Customer not found');
    res.json({ message: 'Customer deleted successfully' });
  } catch (err) {
    console.error('Error deleting customer:', err);
    res.status(500).send('Error deleting customer');
  }
});

/* ---------- VENDORS API ---------- */
app.get('/api/vendors', requireUser, async (req, res) => {
  const userId = req.userId;
  try {
    const result = await pool.query(
      `SELECT * FROM vendors WHERE user_id = $1 ORDER BY id ASC`,
      [userId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching vendors:', err);
    res.status(500).send('Error fetching vendors');
  }
});

app.post('/api/vendors', requireUser, async (req, res) => {
  const userId = req.userId;
  const { name, email, supply_area, phone } = req.body;
  if (!name) {
    return res.status(400).json({ success: false, message: 'Vendor name is required' });
  }
  try {
    const result = await pool.query(
      `INSERT INTO vendors (name, email, supply_area, phone, user_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [name, email || null, supply_area || null, phone || null, userId]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Error adding vendor:', err);
    res.status(500).send('Error adding vendor');
  }
});

app.put('/api/vendors/:id', requireUser, async (req, res) => {
  const userId = req.userId;
  const { id } = req.params;
  const { name, email, supply_area, phone } = req.body;
  if (!name) {
    return res.status(400).json({ success: false, message: 'Vendor name is required' });
  }
  try {
    const result = await pool.query(
      `UPDATE vendors SET name = $1, email = $2, supply_area = $3, phone = $4
       WHERE id = $5 AND user_id = $6 RETURNING *`,
      [name, email || null, supply_area || null, phone || null, id, userId]
    );
    if (result.rowCount === 0) return res.status(404).send('Vendor not found');
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error updating vendor:', err);
    res.status(500).send('Error updating vendor');
  }
});

app.delete('/api/vendors/:id', requireUser, async (req, res) => {
  const userId = req.userId;
  const { id } = req.params;
  try {
    const result = await pool.query(
      `DELETE FROM vendors WHERE id = $1 AND user_id = $2`,
      [id, userId]
    );
    if (result.rowCount === 0) return res.status(404).send('Vendor not found');
    res.json({ message: 'Vendor deleted successfully' });
  } catch (err) {
    console.error('Error deleting vendor:', err);
    res.status(500).send('Error deleting vendor');
  }
});


/* ---------- ORDERS API ---------- */
app.get('/api/orders', requireUser, async (req, res) => {
  const userId = req.userId;
  try {
    const result = await pool.query(
      `SELECT 
         o.id AS order_id,
         o.order_date,
         o.order_value,
         c.name AS customer_name,
         c.id AS customer_id,
         COALESCE(
           '[' || STRING_AGG(
             '{"product_id":' || p.id || ',"name":"' || p.name || '","price":' || p.price || ',"quantity":' || oi.quantity || '}',
             ','
           ) || ']',
           '[]'
         ) AS products
       FROM orders o
       LEFT JOIN customers c ON o.customer_id = c.id
       LEFT JOIN order_items oi ON o.id = oi.order_id
       LEFT JOIN products p ON oi.product_id = p.id
       WHERE o.user_id = $1
       GROUP BY o.id, c.name, c.id
       ORDER BY o.id ASC`, // Added ORDER BY clause for stable ordering
      [userId],
    );
    const orders = result.rows.map((row) => ({
      id: row.order_id,
      order_date: row.order_date,
      order_value: row.order_value,
      customer_name: row.customer_name,
      customer_id: row.customer_id,
      products: JSON.parse(row.products),
    }));
    res.json(orders);
  } catch (err) {
    console.error('Error fetching orders:', err);
    res.status(500).send('Error fetching orders');
  }
});

app.post('/api/orders', requireUser, async (req, res) => {
  const userId = req.userId;
  const { customer_id, items } = req.body;
  if (!customer_id || !items || !Array.isArray(items) || items.length === 0) {
    return res
      .status(400)
      .json({ success: false, message: 'Invalid order data' });
  }

  try {
    // Pre-check stock for each order item
    for (const item of items) {
      const { product_id, quantity } = item;
      const productResult = await pool.query(
        'SELECT name, quantity FROM products WHERE id = $1 AND user_id = $2',
        [product_id, userId],
      );
      if (productResult.rowCount === 0) {
        return res.status(404).json({
          success: false,
          message: `Product with id ${product_id} not found`,
        });
      }
      const product = productResult.rows[0];
      if (parseInt(product.quantity, 10) < parseInt(quantity, 10)) {
        return res.status(400).json({
          success: false,
          message: `Insufficient stock for ${product.name}. Available: ${product.quantity}, requested: ${quantity}.`,
        });
      }
    }
  } catch (error) {
    console.error('Error checking product quantities:', error);
    return res
      .status(500)
      .json({ success: false, message: 'Error checking product quantities' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const orderResult = await client.query(
      'INSERT INTO orders (customer_id, user_id) VALUES ($1, $2) RETURNING id',
      [customer_id, userId],
    );
    const orderId = orderResult.rows[0].id;

    for (const item of items) {
      const { product_id, quantity } = item;
      // Deduct the quantity from product stock
      await client.query(
        'UPDATE products SET quantity = quantity - $1 WHERE id = $2 AND user_id = $3',
        [quantity, product_id, userId],
      );
      // Retrieve product name for logging
      const prodResult = await client.query(
        'SELECT name FROM products WHERE id = $1 AND user_id = $2',
        [product_id, userId],
      );
      const prodName =
        prodResult.rowCount > 0 ? prodResult.rows[0].name : 'Unknown';
      // Log the order creation event with the correct product name
      await logProductHistory(
        product_id,
        prodName,
        'Order Created',
        `Quantity reduced by ${quantity} due to order ${orderId}`,
        userId,
      );
      // Insert the order item record
      await client.query(
        'INSERT INTO order_items (order_id, product_id, quantity, user_id) VALUES ($1, $2, $3, $4)',
        [orderId, product_id, quantity, userId],
      );
    }
    await client.query(
      `UPDATE orders SET order_value = (
         SELECT SUM(p.price * oi.quantity)
         FROM order_items oi
         JOIN products p ON oi.product_id = p.id
         WHERE oi.order_id = $1
       ) WHERE id = $1`,
      [orderId],
    );
    await client.query('COMMIT');
    res.status(201).json({ success: true, order: { id: orderId } });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error creating order:', err);
    res.status(500).json({ success: false, message: 'Error creating order' });
  } finally {
    client.release();
  }
});

app.put('/api/orders/:id', requireUser, async (req, res) => {
  const userId = req.userId;
  const { id } = req.params; // Order ID to update
  const { customer_id, order_date, items } = req.body;

  // Validate incoming data (ensure order_date is present and non‑empty)
  if (!customer_id) {
    console.error('Validation Error: Missing customer_id');
    return res
      .status(400)
      .json({ success: false, message: 'Missing customer_id' });
  }
  if (!order_date || order_date.trim() === '') {
    console.error('Validation Error: Missing or empty order_date');
    return res
      .status(400)
      .json({ success: false, message: 'Missing order_date' });
  }
  if (!items) {
    console.error('Validation Error: Missing items array');
    return res.status(400).json({ success: false, message: 'Missing items' });
  }
  if (!Array.isArray(items)) {
    console.error('Validation Error: Items is not an array');
    return res
      .status(400)
      .json({ success: false, message: 'Items must be an array' });
  }
  if (items.length === 0) {
    console.error('Validation Error: Items array is empty');
    return res
      .status(400)
      .json({ success: false, message: 'Items array is empty' });
  }

  const client = await pool.connect();
  try {
    console.log(
      `Updating order ${id} for user ${userId} with order_date ${order_date}`,
    );
    await client.query('BEGIN');

    // Verify that the order exists
    const orderCheck = await client.query(
      'SELECT id FROM orders WHERE id = $1 AND user_id = $2',
      [id, userId],
    );
    if (orderCheck.rowCount === 0) {
      console.error(`Order ${id} not found for user ${userId}`);
      await client.query('ROLLBACK');
      return res
        .status(404)
        .json({ success: false, message: 'Order not found' });
    }
    console.log(`Order ${id} exists; proceeding with update.`);

    // Refund current order items (add back quantities) and log history
    const existingResult = await client.query(
      'SELECT product_id, quantity FROM order_items WHERE order_id = $1 AND user_id = $2',
      [id, userId],
    );
    const existingItems = existingResult.rows;
    for (const item of existingItems) {
      await client.query(
        'UPDATE products SET quantity = quantity + $1 WHERE id = $2 AND user_id = $3',
        [item.quantity, item.product_id, userId],
      );
      // Retrieve product name for logging
      const prodRes = await client.query(
        'SELECT name FROM products WHERE id = $1 AND user_id = $2',
        [item.product_id, userId],
      );
      const prodName = prodRes.rowCount > 0 ? prodRes.rows[0].name : 'Unknown';
      await logProductHistory(
        item.product_id,
        prodName,
        'Order Edited - Refunded',
        `Refunded quantity ${item.quantity} for order ${id}`,
        userId,
      );
    }
    console.log(
      `Refunded ${existingItems.length} existing order items for order ${id}`,
    );

    // Delete existing order items
    await client.query(
      'DELETE FROM order_items WHERE order_id = $1 AND user_id = $2',
      [id, userId],
    );
    console.log('Deleted existing order items');

    // Process new order items: check stock, deduct new quantity, log history, and insert new order items
    for (const item of items) {
      const { product_id, quantity } = item;
      const productResult = await client.query(
        'SELECT name, quantity, price FROM products WHERE id = $1 AND user_id = $2',
        [product_id, userId],
      );
      if (productResult.rowCount === 0) {
        console.error(
          `Product with id ${product_id} not found for user ${userId}`,
        );
        await client.query('ROLLBACK');
        return res.status(404).json({
          success: false,
          message: `Product with id ${product_id} not found`,
        });
      }
      const product = productResult.rows[0];
      if (parseInt(product.quantity, 10) < parseInt(quantity, 10)) {
        console.error(
          `Insufficient stock for ${product.name}: available ${product.quantity}, requested ${quantity}`,
        );
        await client.query('ROLLBACK');
        return res.status(400).json({
          success: false,
          message: `Insufficient stock for ${product.name}. Available: ${product.quantity}, requested: ${quantity}.`,
        });
      }
      // Deduct new quantity from product stock
      await client.query(
        'UPDATE products SET quantity = quantity - $1 WHERE id = $2 AND user_id = $3',
        [quantity, product_id, userId],
      );
      await logProductHistory(
        product_id,
        product.name,
        `Order Edited - Deducted`,
        `Deducted quantity ${quantity} for order ${id}`,
        userId,
      );
      await client.query(
        'INSERT INTO order_items (order_id, product_id, quantity, user_id) VALUES ($1, $2, $3, $4)',
        [id, product_id, quantity, userId],
      );
    }
    console.log('Processed new order items');

    // Update the order's customer_id and order_date
    await client.query(
      'UPDATE orders SET customer_id = $1, order_date = $2 WHERE id = $3 AND user_id = $4',
      [customer_id, order_date.trim(), id, userId],
    );
    console.log("Updated order's customer_id and order_date");

    // Recalculate the order's total value
    await client.query(
      `UPDATE orders SET order_value = (
       SELECT COALESCE(SUM(p.price * oi.quantity), 0)
       FROM order_items oi
       JOIN products p ON oi.product_id = p.id
       WHERE oi.order_id = $1
     ) WHERE id = $1`,
      [id],
    );
    console.log('Recalculated order value');

    await client.query('COMMIT');

    // Fetch and return the updated order details
    const orderFetchResult = await pool.query(
      `SELECT 
       o.id AS order_id,
       o.order_date,
       o.order_value,
       c.name AS customer_name,
       c.id AS customer_id,
       COALESCE(
         '[' || STRING_AGG('{"product_id":' || p.id || ',"name":"' || p.name || '","price":' || p.price || ',"quantity":' || oi.quantity || '}', ',') || ']',
         '[]'
       ) AS products
     FROM orders o
     LEFT JOIN customers c ON o.customer_id = c.id
     LEFT JOIN order_items oi ON o.id = oi.order_id
     LEFT JOIN products p ON oi.product_id = p.id
     WHERE o.id = $1 AND o.user_id = $2
     GROUP BY o.id, c.name, c.id`,
      [id, userId],
    );
    console.log('Order updated successfully.');
    res.json({ success: true, order: orderFetchResult.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error updating order:', err);
    res.status(500).json({ success: false, message: 'Error updating order' });
  } finally {
    client.release();
  }
});

app.delete('/api/orders/:id', requireUser, async (req, res) => {
  const userId = req.userId;
  const { id } = req.params;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Refund stock for order items and log history
    const itemsResult = await client.query(
      'SELECT product_id, quantity FROM order_items WHERE order_id = $1 AND user_id = $2',
      [id, userId],
    );
    const items = itemsResult.rows;
    for (const item of items) {
      await client.query(
        'UPDATE products SET quantity = quantity + $1 WHERE id = $2 AND user_id = $3',
        [item.quantity, item.product_id, userId],
      );
      await logProductHistory(
        item.product_id,
        product.name, // 'product.name' from the context
        'Order Deleted - Refunded',
        `Refunded quantity ${item.quantity} for deleted order ${id}`,
        userId,
      );
    }
    await client.query(
      'DELETE FROM order_items WHERE order_id = $1 AND user_id = $2',
      [id, userId],
    );
    const result = await client.query(
      'DELETE FROM orders WHERE id = $1 AND user_id = $2',
      [id, userId],
    );
    if (result.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).send('Order not found');
    }
    await client.query('COMMIT');
    res.json({ success: true, message: 'Order deleted successfully' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error deleting order:', err);
    res.status(500).json({ success: false, message: 'Error deleting order' });
  } finally {
    client.release();
  }
});

/* ---------- EMAIL VALIDATION API ---------- */

app.post('/api/validate-email', async (req, res) => {
  const { email } = req.body;
  if (!email) {
    return res
      .status(400)
      .json({ success: false, message: 'Email is required.' });
  }
  const apiKey = process.env.EMAIL_VALIDATION_API_KEY;
  if (!apiKey) {
    console.error('EMAIL_VALIDATION_API_KEY is not set.');
    return res.status(500).json({
      success: false,
      message: 'Server configuration error: Missing API key.',
    });
  }
  const url = `https://apilayer.net/api/check?access_key=${apiKey}&email=${encodeURIComponent(email)}&smtp=1&format=1`;
  console.log('Calling email validation API:', url);
  try {
    const response = await fetch(url);
    if (!response.ok) {
      console.error('Email validation API error:', response.status);
      return res.status(500).json({
        success: false,
        message: `Email validation request failed: ${response.status}`,
      });
    }
    const data = await response.json();
    console.log('Email validation API returned:', data);
    // Updated version: only require the email format to be valid
    return res.json({
      success: true,
      valid: data.format_valid,
      details: data,
    });
  } catch (err) {
    console.error('Error validating email:', err);
    return res
      .status(500)
      .json({ success: false, message: 'Error validating email.' });
  }
});

app.post("/api/validate-phone", async (req, res) => {
  const { phone } = req.body;
  if (!phone || phone.length !== 10 || isNaN(phone)) {
    return res.status(400).json({ success: false, message: "Invalid phone format. Must be 10 digits." });
  }
  const apiKey = process.env.PHONE_VALIDATION_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ success: false, message: "Server misconfiguration: API key missing." });
  }
  // Assuming you are validating for Indian phone numbers; you may change country_code if needed
  const url = `http://apilayer.net/api/validate?access_key=${apiKey}&number=${encodeURIComponent(phone)}&country_code=IN&format=1`;
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Phone validation request failed: ${response.status}`);
    const data = await response.json();
    if (data.valid) {
      res.json({ success: true, valid: true, country: data.country_name });
    } else {
      res.json({ success: false, valid: false, message: "Invalid phone number." });
    }
  } catch (error) {
    console.error("Error validating phone:", error);
    res.status(500).json({ success: false, message: "Phone validation service error." });
  }
});

app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
