// Design A4: up() names the index, down() drops it by the default name, which doesn't exist.
module.exports = {
  description: 'Index orders by customer and date',

  async up({ db }) {
    await db
      .collection('orders')
      .createIndex({ customerId: 1, createdAt: -1 }, { name: 'orders_by_customer_date' });
  },
  async down({ db }) {
    // The index is called orders_by_customer_date, not the default name:
    await db.collection('orders').dropIndex('customerId_1_createdAt_-1');
  },
};
