'use strict';

module.exports = {
    up: async (queryInterface, Sequelize) => {
        try {
            await queryInterface.addColumn('html_locations', 'width', { type: Sequelize.DOUBLE, allowNull: true })
            await queryInterface.addColumn('html_locations', 'height', { type: Sequelize.DOUBLE, allowNull: true })
            await queryInterface.changeColumn('html_locations', 'start_offset', { type: Sequelize.DOUBLE, allowNull: false })
            await queryInterface.changeColumn('html_locations', 'end_offset', { type: Sequelize.DOUBLE, allowNull: false })
        } catch(err) {}
    },

    down: async (queryInterface, Sequelize) => {
        await queryInterface.removeColumn('html_locations', 'width')
        await queryInterface.removeColumn('html_locations', 'height')
        await queryInterface.changeColumn('html_locations', 'start_offset', { type: Sequelize.INTEGER, allowNull: false })
        await queryInterface.changeColumn('html_locations', 'end_offset', { type: Sequelize.INTEGER, allowNull: false })
    }
};
