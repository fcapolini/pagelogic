window.pagelogic.init({
  id: 0,
  name: 'page',
  children: [
    {
      id: 1,
      name: 'head'
    },
    {
      id: 2,
      name: 'body',
      values: {
        y: {
          exp: function () {
            return '';
          }
        },
        text$0: {
          exp: function () {
            return this.y + '!';
          },
          refs: [function () {
              return this.$value('y');
            }]
        }
      }
    }
  ]
});
