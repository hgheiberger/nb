'use strict';

module.exports = {
    up: async (queryInterface, Sequelize) => {
        try {
            await queryInterface.addColumn('html_locations', 'width', { type: Sequelize.INTEGER, allowNull: true })
            await queryInterface.addColumn('html_locations', 'height', { type: Sequelize.INTEGER, allowNull: true })
        } catch(err) {}
    },

    down: async (queryInterface, Sequelize) => {
        await queryInterface.removeColumn('html_locations', 'width')
        await queryInterface.removeColumn('html_locations', 'height')
    }
};
