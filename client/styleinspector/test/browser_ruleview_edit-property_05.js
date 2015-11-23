/* vim: set ft=javascript ts=2 et sw=2 tw=80: */
/* Any copyright is dedicated to the Public Domain.
 http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Tests that a disabled property is re-enabled if the property name or value is
// modified

const TEST_URI = `
  <style type='text/css'>
  #testid {
    background-color: blue;
  }
  </style>
  <div id='testid'>Styled Node</div>
`;

add_task(function*() {
  yield addTab("data:text/html;charset=utf-8," + encodeURIComponent(TEST_URI));
  let {inspector, view} = yield openRuleView();
  yield selectNode("#testid", inspector);
  yield testEditingDisableProperty(inspector, view);
});

function* testEditingDisableProperty(inspector, view) {
  let ruleEditor = getRuleViewRuleEditor(view, 1);
  let propEditor = ruleEditor.rule.textProps[0].editor;

  info("Disabling background-color property");
  propEditor.enable.click();
  yield ruleEditor.rule._applyingModifications;

  let newValue = yield getRulePropertyValue("background-color");
  is(newValue, "", "background-color should have been unset.");

  yield focusEditableField(view, propEditor.nameSpan);

  info("Entering a new property name, including : to commit and " +
       "focus the value");
  let onValueFocus = once(ruleEditor.element, "focus", true);
  EventUtils.sendString("border-color:", view.styleWindow);
  yield onValueFocus;
  yield ruleEditor.rule._applyingModifications;

  info("Escape editing the property value");
  EventUtils.synthesizeKey("VK_ESCAPE", {}, view.styleWindow);
  yield ruleEditor.rule._applyingModifications;

  newValue = yield getRulePropertyValue("border-color");
  is(newValue, "blue", "border-color should have been set.");

  ok(propEditor.prop.enabled, "border-color property is enabled.");
  ok(!propEditor.element.classList.contains("ruleview-overridden"),
    "border-color is not overridden");

  info("Disabling border-color property");
  propEditor.enable.click();
  yield ruleEditor.rule._applyingModifications;

  newValue = yield getRulePropertyValue("border-color");
  is(newValue, "", "border-color should have been unset.");

  info("Enter a new property value for the border-color property");
  let editor = yield focusEditableField(view, propEditor.valueSpan);
  let onBlur = once(editor.input, "blur");
  EventUtils.sendString("red;", view.styleWindow);
  yield onBlur;
  yield ruleEditor.rule._applyingModifications;

  newValue = yield getRulePropertyValue("border-color");
  is(newValue, "red", "new border-color should have been set.");

  ok(propEditor.prop.enabled, "border-color property is enabled.");
  ok(!propEditor.element.classList.contains("ruleview-overridden"),
    "border-color is not overridden");
}

function* getRulePropertyValue(name) {
  let propValue = yield executeInContent("Test:GetRulePropertyValue", {
    styleSheetIndex: 0,
    ruleIndex: 0,
    name: name
  });
  return propValue;
}
