#include <stdlib.h>
#include <stdio.h>
#include "misc.h"
#include "common.h"
#include "padi.h"
#include "doublist.h"

//////////////////////////// Class DoublyList /////////////////////////////
DoublyList::~DoublyList()
{
  Padi *currpadi, *tmp;
  for (currpadi=head ; currpadi!=NULL ; )
  {
    tmp = currpadi;
    currpadi = currpadi->next;
    delete tmp;
  }
  last = head = NULL;
}


void DoublyList::Append(Padi *input)
{
#ifdef SECURITY
  if (input==NULL)
  {
    ERRMSG("[DoublyList::Append]: invalid input value\n");
    return;
  }
#endif
  if (last==NULL)
    last = head = input;
  else
  {
    last->next = input;
    input->previous = last;
    last = last->next;
  }
}


// It remove the input from the doubly linked list
// It will not delete input
void DoublyList::Remove(Padi *input)
{
#ifdef SECURITY
  if (input==NULL)
  {
    ERRMSG("[DoublyList::Remove]:invalid input value\n");
    return;
  }
#endif
  if (input==head)
    head = input->next;
  else
    input->previous->next = input->next;
  if (input==last)
    last = input->previous;
  else
    input->next->previous = input->previous;
  input->previous = input->next = NULL;
}

