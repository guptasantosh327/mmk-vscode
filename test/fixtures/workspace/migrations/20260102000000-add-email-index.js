module.exports = {
  description: 'Add a unique index on users.email',
  author: 'Fixture Author <fixture@example.com>',

  async up({ db }) {
    await db.collection('users').createIndex({ email: 1 }, { unique: true, name: 'email_1' });
  },

  async down({ db }) {
    await db.collection('users').dropIndex('email_1');
  },
};
