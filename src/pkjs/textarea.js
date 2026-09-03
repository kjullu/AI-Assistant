module.exports = {
  name: 'textarea',
  template:
    '<div class="component component-textarea">' +
      '<label>' +
        '<span class="label">{{{label}}}</span>' +
        '<span class="input">' +
          '<textarea data-manipulator-target ' +
            '{{each key: attributes}}{{key}}="{{this}}"{{/each}}></textarea>' +
        '</span>' +
      '</label>' +
      '{{if description}}<div class="description">{{{description}}}</div>{{/if}}' +
    '</div>',
  style:
    '.section .component-textarea{padding:0}' +
    '.component-textarea label{display:block}' +
    '.component-textarea .label{padding-bottom:.7rem}' +
    '.component-textarea .input{display:block;min-width:100%;margin-top:.7rem}' +
    '.component-textarea textarea{' +
      'box-sizing:border-box;display:block;width:100%;min-height:6.3rem;' +
      'background:#333;border-radius:.25rem;padding:.35rem .375rem;border:none;' +
      'color:#fff;font:inherit;line-height:1.35;resize:vertical;' +
      '-webkit-appearance:none;appearance:none' +
    '}' +
    '.component-textarea textarea::-webkit-input-placeholder{color:#858585}' +
    '.component-textarea textarea:focus{border:none;box-shadow:none}',
  manipulator: 'val',
  defaults: {
    label: '',
    description: '',
    attributes: { rows: 4 }
  }
};
