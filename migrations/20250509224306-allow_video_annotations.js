'use strict';

module.exports = {
    up: async (queryInterface, Sequelize) => {
        try {
            await queryInterface.addColumn('html_locations', 'start_time', { type: Sequelize.DOUBLE, allowNull: true })
            await queryInterface.addColumn('html_locations', 'end_time', { type: Sequelize.DOUBLE, allowNull: true })
        } catch(err) {}
    },

    down: async (queryInterface, Sequelize) => {
        await queryInterface.removeColumn('html_locations', 'start_time')
        await queryInterface.removeColumn('html_locations', 'end_time')
    }
};
