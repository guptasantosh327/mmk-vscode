module.exports = {
  description: 'Give every user a status',
  author: 'Fixture Author <fixture@example.com>',

  async up({ db }) {
    await db
      .collection('users')
      .updateMany({ status: { $exists: false } }, { $set: { status: 'active' } });
  },

  async down({ db }) {
    await db.collection('users').updateMany({}, { $unset: { status: '' } });
  },
};
