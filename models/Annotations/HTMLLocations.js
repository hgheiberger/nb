const htmlLocation = (sequelize, DataTypes) => {
  const HtmlLocation = sequelize.define('html_location', {
    id:{
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV1,
      primaryKey: true
    },
    start_node:{
      type: DataTypes.STRING,
      allowNull: false
    },
    end_node:{
      type: DataTypes.STRING,
      allowNull: false
    },
    start_offset:{
      type: DataTypes.DOUBLE,
      allowNull: false
    },
    end_offset:{
      type: DataTypes.DOUBLE,
      allowNull: false
    },
    width:{
      type: DataTypes.DOUBLE,
      allowNull: true
    },
    height:{
      type: DataTypes.DOUBLE,
      allowNull: true
    },
    start_time:{
      type: DataTypes.DOUBLE,
      allowNull: true
    },
    end_time:{
      type: DataTypes.DOUBLE,
      allowNull: true
    },
  },
  {
    classMethods:{
      associate: (models) => {
        HtmlLocation.belongsTo(models.Location, {as: 'Location', foreignKey: {name: 'location_id', allowNull: false}, onDelete: 'CASCADE'});
      }
    }
  });
  return HtmlLocation;
};

module.exports = htmlLocation;