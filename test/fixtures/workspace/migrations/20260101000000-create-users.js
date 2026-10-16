module.exports = {
  description: 'Create the users collection',
  author: 'Fixture Author <fixture@example.com>',

  async up({ db }) {
    await db.createCollection('users');
  },

  async down({ db }) {
    await db.collection('users').drop();
  },
};
